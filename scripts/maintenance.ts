/** Offline only. Stop every bridge worker first. This is not a full erasure tool. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schema1, schema2, schema3 } from './maintenance-schema.js';
import { MaintenanceTarget } from './maintenance-target.js';

type Request = { operation: 'purge' | 'revoke'; owner?: string; dryRun: boolean };
const usage = 'Usage: (Linux + /proc/self/fd only) DATABASE_PATH=<existing-file> node dist/scripts/maintenance.js purge [--dry-run] | revoke <principal-hash> [--dry-run]; stop every bridge worker first';
const terminal = "'sent','dead','cancelled','blocked'";
const states = `${terminal},'pending','sending','uncertain'`;

export function parseRequest(args: string[]): Request {
  const dryRun = args.at(-1) === '--dry-run';
  const words = dryRun ? args.slice(0, -1) : args;
  if (words.length === 1 && words[0] === 'purge') return { operation: 'purge', dryRun };
  if (words.length === 2 && words[0] === 'revoke' && /^[a-f0-9]{64}$/.test(words[1]!)) return { operation: 'revoke', owner: words[1], dryRun };
  throw new Error(usage);
}

function schemaDescription(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()
    .map(row => ({ ...row, sql: String(row.sql).replace(/\bIF NOT EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim() })));
}

function validate(db: DatabaseSync): 1 | 2 | 3 {
  const version = db.prepare('PRAGMA user_version').get()!.user_version;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error('Unsupported database schema version; no changes made');
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(version === 1 ? schema1 : version === 2 ? schema2 : schema3);
    if (schemaDescription(db) !== schemaDescription(reference)) throw new Error('Unrecognized database schema; no changes made');
  } finally { reference.close(); }
  const integrity = db.prepare('PRAGMA quick_check').all();
  if (integrity.length !== 1 || integrity[0]!.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Database integrity check failed; no changes made');
  const invalid = (sql: string) => { if (db.prepare(`SELECT 1 ${sql} LIMIT 1`).get()) throw new Error('Malformed database state; no changes made'); };
  // SQLite affinity alone does not validate identities, timestamps or counters.
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all()) {
    for (const col of db.prepare(`PRAGMA table_info(${name})`).all()) {
      const nullable = !col.notnull && !col.pk;
      const condition = col.type === 'TEXT' ? `typeof(${col.name})!='text'`
        : `typeof(${col.name})!='integer' OR ${col.name}<0 OR ${col.name}>9007199254740991`;
      invalid(`FROM ${name} WHERE ${nullable ? `${col.name} IS NOT NULL AND (${condition})` : condition}`);
    }
  }
  for (const table of ['bindings', 'subscriptions']) invalid(`FROM ${table} WHERE active NOT IN (0,1)`);
  invalid("FROM inbox WHERE unixepoch(timestamp,'subsec') IS NULL");
  for (const table of version >= 2 ? ['jobs', 'mirror_outbox'] : ['jobs']) {
    invalid(`FROM ${table} WHERE state NOT IN (${states}) OR CASE WHEN json_valid(payload) THEN json_type(payload)!='object' ELSE 1 END`);
  }
  invalid("FROM jobs WHERE kind NOT IN ('event','reply')");
  for (const table of version >= 2 ? ['inbox', 'mirror_outbox'] : ['inbox']) invalid(`FROM ${table} i JOIN bindings b ON b.id=i.bindingId WHERE i.owner!=b.owner OR i.appId!=b.appId OR i.tenantKey!=b.tenantKey OR i.openId!=b.openId OR i.chatId!=b.chatId`);
  invalid('FROM subscriptions s JOIN bindings b ON b.id=s.bindingId WHERE s.owner!=b.owner');
  return version;
}

// Keep all receipts: deleting an inbox body must not permit reingestion of its ID.
function purgeSteps(version: 1 | 2 | 3, at: number) {
  const cutoff = at - 30 * 86400000;
  const inbox = `SELECT i.id FROM inbox i WHERE unixepoch(i.timestamp,'subsec')*1000<${cutoff}
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.inboxId=i.id AND j.state NOT IN (${terminal}))`;
  const subscriptions = `SELECT s.id FROM subscriptions s WHERE s.expiresAt<${cutoff}
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.subscriptionId=s.id AND j.inboxId NOT IN (${inbox}))`;
  return [
    ['pairs', `expiresAt<${at}`],
    ...(version >= 2 ? [['content_dispositions', `eventId IN (${inbox})`]] : []),
    ['jobs', `inboxId IN (${inbox})`],
    ['inbox', `id IN (${inbox})`],
    ['subscriptions', `id IN (${subscriptions})`],
    ['bindings', `active=0 AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.bindingId=bindings.id AND i.id NOT IN (${inbox}))
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.bindingId=bindings.id AND s.id NOT IN (${subscriptions}))
      ${version >= 2 ? 'AND NOT EXISTS (SELECT 1 FROM mirror_outbox m WHERE m.bindingId=bindings.id)' : ''}`],
  ] as const;
}

function perform(db: DatabaseSync, request: Request, at: number, apply: boolean, check: () => void) {
  const version = validate(db);
  check();
  if (request.operation === 'revoke') {
    if (apply) {
      check(); db.prepare('INSERT OR IGNORE INTO revoked(owner) VALUES (?)').run(request.owner!);
      check(); db.prepare('UPDATE bindings SET active=0 WHERE owner=?').run(request.owner!);
      check(); db.prepare('UPDATE subscriptions SET active=0 WHERE owner=?').run(request.owner!);
      check(); db.prepare('DELETE FROM pairs WHERE owner=?').run(request.owner!);
      check(); if (version >= 2) db.prepare("UPDATE mirror_outbox SET state='cancelled' WHERE owner=? AND state='pending'").run(request.owner!);
    }
    return { event: apply ? 'account_revoked' : 'account_revoke_validated', schema_version: version, dry_run: !apply };
  }
  // Never recreate missing reservations from potentially malformed history.
  const inboxPredicate = purgeSteps(version, at).find(([table]) => table === 'inbox')![1];
  const receiptExists = db.prepare('SELECT 1 FROM receipts WHERE id=?');
  for (const row of db.prepare(`SELECT id,appId,tenantKey,messageId FROM inbox WHERE ${inboxPredicate}`).iterate()) {
    const receipt = createHash('sha256').update(JSON.stringify([row.appId, row.tenantKey, row.messageId])).digest('hex');
    if (row.id !== `evt_${receipt}` || !receiptExists.get(receipt)) throw new Error('Missing or invalid inbox deduplication reservation; no changes made');
  }
  const counts: Record<string, number> = {};
  for (const [table, predicate] of purgeSteps(version, at)) {
    check();
    counts[table!] = apply ? Number(db.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run().changes)
      : Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`).get()!.n);
  }
  return { event: apply ? 'eligible_inbox_history_cleanup_complete' : 'eligible_inbox_history_cleanup_preview', schema_version: version, dry_run: !apply, inbox_age_days: 30, counts, receipts_retained: true, mirror_rows_and_bodies_retained: true };
}

export function runMaintenance(args: string[], path: string | undefined, at = Date.now()) {
  const request = parseRequest(args); // Validate before filesystem/database access.
  if (!Number.isSafeInteger(at) || at < 30 * 86400000) throw new Error('Invalid maintenance time');
  const target = new MaintenanceTarget(path), read = target.open(true);
  let preview;
  try {
    read.db.exec('BEGIN');
    preview = perform(read.db, request, at, false, read.check);
    read.check();
  } finally { read.db.close(); }
  if (request.dryRun) return preview;
  const write = target.open(false);
  try {
    write.check(); write.db.exec('BEGIN IMMEDIATE');
    try {
      // Revalidate under the write lock; never migrate or recover sending jobs.
      const result = perform(write.db, request, at, true, write.check);
      write.check(); write.db.exec('COMMIT');
      return result;
    } catch (error) { write.db.exec('ROLLBACK'); throw error; }
  } finally { write.db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runMaintenance(process.argv.slice(2), process.env.DATABASE_PATH))); }
  catch { console.error(JSON.stringify({ event: 'maintenance_failed', message: 'No successful maintenance result. Check Linux /proc access, owner-only file/directory permissions, arguments, DATABASE_PATH, supported schema and database integrity; stop every bridge worker first.', usage })); process.exitCode = 1; }
}
