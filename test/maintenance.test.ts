/** Only fresh synthetic temp databases and mock transports. Never use runtime files. */
import { test as nodeTest } from 'node:test';
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { skip: process.platform !== 'linux' && 'Linux-only maintenance command' }, fn);
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './fixtures.js';
import { hash, SecretBox } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { runMaintenance, parseRequest } from '../scripts/maintenance.js';

const DAY = 86400000;
function synthetic() {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-maintenance-'));
  const path = join(dir, 'fixture.sqlite'), f = fixture(path), binding = f.bind();
  f.sender.sendBound = async () => 'om_MOCK_remote';
  const old = new Date(f.now() - 40 * DAY).toISOString();
  let n = 0;
  function inbox(state?: string, omission = false, timestamp = old) {
    const message = f.message({ messageId: `om_MOCK_${++n}`, ...(omission ? { contentStatus: 'unsupported' as const } : {}) });
    f.bridge.receive(message);
    const id = `evt_${hash(JSON.stringify([message.appId, message.tenantKey, message.messageId]))}`;
    if (state) {
      const queued = f.bridge.reply(f.alice, { event_id: id, text: 'MOCK reply body' });
      f.store.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state, queued.reply_id);
    }
    f.store.db.prepare('UPDATE inbox SET timestamp=? WHERE id=?').run(timestamp, id);
    return { id, message };
  }
  function mirror(state: string, source = `MOCK_source_${++n}`) {
    const input = { binding_id: binding.id, source_message_id: source, source_role: 'user' as const, text: 'MOCK mirror body' };
    const queued = f.bridge.sendToBoundFeishu(f.alice, input);
    f.store.db.prepare('UPDATE mirror_outbox SET state=?,firstAttemptAt=?,accessUntil=?,remoteMessageId=? WHERE id=?')
      .run(state, f.now() - 40 * DAY, f.now() - 39 * DAY, state === 'sent' ? 'om_MOCK_confirmed' : null, queued.sync_id);
    return { id: queued.sync_id, input };
  }
  function downgrade(version: 1 | 2 | 3 = 1) {
    if (version < 3) for (const name of ['remoteMessageId', 'rootMessageId', 'parentMessageId', 'threadId', 'completedAt']) f.store.db.exec('ALTER TABLE jobs DROP COLUMN ' + name);
    if (version === 1) f.store.db.exec('DROP TABLE mirror_outbox; DROP TABLE content_dispositions');
    f.store.db.exec('PRAGMA user_version=' + version);
  }
  return { ...f, dir, path, binding, old, inbox, mirror, downgrade, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result: Record<string, unknown> = { version: db.prepare('PRAGMA user_version').get(), schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all() };
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()) result[String(name)] = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    return result;
  } finally { db.close(); }
}
function alter(path: string, sql: string) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }

for (const version of [1, 2, 3] as const) test(`schema ${version}: scoped cleanup keeps outstanding work, receipts and boundary events; dry run matches execution`, () => {
  const f = synthetic();
  try {
    const removed = [f.inbox(), ...['sent', 'dead', 'cancelled', 'blocked'].map(s => f.inbox(s, version >= 2))];
    const kept = ['pending', 'sending', 'uncertain'].map(s => f.inbox(s, version >= 2));
    kept.push(f.inbox(undefined, false, new Date(f.now() - 30 * DAY).toISOString()));
    kept.push(f.inbox(undefined, false, new Date(f.now()).toISOString()));
    const mixed = f.inbox('sent', version >= 2); kept.push(mixed);
    f.store.db.prepare('INSERT INTO jobs(id,kind,lane,inboxId,payload,state) VALUES (?,?,?,?,?,?)').run('MOCK_mixed', 'event', 'event:MOCK', mixed.id, '{}', 'pending');
    f.store.db.prepare('INSERT INTO pairs VALUES (?,?,?)').run('MOCK_expired', f.alice.id, f.now() - 1);
    f.downgrade(version);
    f.store.close();
    const before = rows(f.path), bytes = readFileSync(f.path);
    const dry = runMaintenance(['purge', '--dry-run'], f.path, f.now());
    assert.equal(dry.dry_run, true); assert.deepEqual(rows(f.path), before); assert.deepEqual(readFileSync(f.path), bytes);
    const result = runMaintenance(['purge'], f.path, f.now());
    assert.equal(result.event, 'eligible_inbox_history_cleanup_complete'); assert.deepEqual(result.counts, dry.counts);
    assert.equal(result.counts!.inbox, removed.length); assert.equal(result.counts!.jobs, 4); assert.equal(result.counts!.pairs, 1);
    const after = rows(f.path); assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.version, before.version);
    assert.deepEqual((after.inbox as { id: string }[]).map(r => r.id), kept.map(r => r.id).sort((a, b) => (before.inbox as { id: string }[]).findIndex(x => x.id === a) - (before.inbox as { id: string }[]).findIndex(x => x.id === b)));
    assert.deepEqual((after.jobs as { state: string }[]).map(j => j.state), ['pending', 'sending', 'uncertain', 'sent', 'pending']);
    if (version >= 2) assert.equal((after.content_dispositions as unknown[]).length, 4);
    const repeated = runMaintenance(['purge'], f.path, f.now()); assert.ok(Object.values(repeated.counts!).every(n => n === 0)); assert.deepEqual(rows(f.path), after);
  } finally { f.cleanup(); }
});

test('schema 2: mirror bodies/metadata/reservations survive every state and protect inactive bindings', () => {
  const f = synthetic();
  try {
    for (const state of ['pending', 'sending', 'uncertain', 'sent', 'dead', 'cancelled', 'blocked']) f.mirror(state);
    f.inbox('sent', true);
    f.store.db.prepare('UPDATE bindings SET active=0 WHERE id=?').run(f.binding.id);
    f.store.db.prepare('INSERT INTO bindings VALUES (?,?,?,?,?,?,?)').run('bind_MOCK_unused', 'MOCK_other', 'cli_other', 'tenant_other', 'ou_other', 'oc_other', 0);
    f.store.close(); const before = rows(f.path);
    const dry = runMaintenance(['purge', '--dry-run'], f.path, f.now());
    const result = runMaintenance(['purge'], f.path, f.now());
    assert.deepEqual(result.counts, dry.counts); assert.equal(result.counts!.bindings, 1);
    const after = rows(f.path);
    assert.deepEqual(after.mirror_outbox, before.mirror_outbox);
    assert.deepEqual((after.bindings as { id: string }[]).map(b => b.id), [f.binding.id]);
    assert.deepEqual(after.inbox, []); assert.deepEqual(after.content_dispositions, []);
    assert.equal(result.mirror_rows_and_bodies_retained, true);
  } finally { f.cleanup(); }
});

test('expired subscriptions and inactive bindings survive while any retained job needs them', async () => {
  const f = synthetic();
  try {
    const sub = await f.subscribe();
    f.inbox('sending', true); // Includes a pending callback job from the subscription.
    f.store.db.prepare('UPDATE subscriptions SET active=0,expiresAt=?').run(f.now() - 40 * DAY);
    f.store.db.prepare('UPDATE bindings SET active=0').run();
    f.store.db.prepare('INSERT INTO bindings VALUES (?,?,?,?,?,?,?)').run('bind_MOCK_free', 'MOCK_other', 'cli_other', 'tenant_other', 'ou_other', 'oc_other', 0);
    f.store.db.prepare('INSERT INTO subscriptions(id,owner,bindingId,url,secret,expiresAt,active) VALUES (?,?,?,?,?,?,?)')
      .run('sub_MOCK_free', 'MOCK_other', 'bind_MOCK_free', 'https://mock.invalid', 'MOCK_SECRET', f.now() - 40 * DAY, 0);
    f.store.close(); const before = rows(f.path);
    const dry = runMaintenance(['purge', '--dry-run'], f.path, f.now());
    const result = runMaintenance(['purge'], f.path, f.now());
    assert.deepEqual(result.counts, dry.counts); assert.equal(result.counts!.subscriptions, 1); assert.equal(result.counts!.bindings, 1);
    const after = rows(f.path); assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.inbox, before.inbox);
    assert.deepEqual((after.subscriptions as { id: string }[]).map(s => s.id), [sub.id]);
    assert.deepEqual((after.bindings as { id: string }[]).map(b => b.id), [f.binding.id]);
  } finally { f.cleanup(); }
});

test('a concurrent write lock fails instead of recovering or partially deleting data', () => {
  const f = synthetic();
  try {
    f.inbox('sent', true); f.inbox('sending'); f.mirror('sending'); f.store.close();
    const before = rows(f.path), lock = new DatabaseSync(f.path);
    try { lock.exec('BEGIN IMMEDIATE'); assert.throws(() => runMaintenance(['purge'], f.path, f.now()), /locked/); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
    assert.deepEqual(rows(f.path), before);
  } finally { f.cleanup(); }
});

test('terminal mirrors and cleaned inboxes cannot resend/reingest after the remote dedupe window', async () => {
  const f = synthetic();
  try {
    const old = f.inbox('sent', true), mirror = f.mirror('sent');
    const before = f.store.mirrorJob(mirror.id); f.store.close();
    runMaintenance(['purge'], f.path, f.now()); runMaintenance(['purge'], f.path, f.now());
    const store = new Store(f.path); let sends = 0;
    try {
      const now = f.now() + 40 * DAY;
      const bridge = new Bridge(store, new SecretBox(f.storageKey), f.transport, { ...f.sender, sendBound: async () => { sends++; return 'om_MOCK_unexpected'; } }, () => now);
      const principal = { ...f.alice, expiresAt: now + DAY };
      assert.equal(bridge.receive({ ...old.message, timestamp: new Date(now).toISOString(), text: 'MOCK replay body' }).state, 'duplicate');
      assert.equal(store.inbox(old.id), undefined);
      const repeated = bridge.sendToBoundFeishu(principal, mirror.input);
      assert.equal(repeated.sync_id, mirror.id); assert.equal(repeated.state, 'sent'); assert.deepEqual(store.mirrorJob(mirror.id), before);
      assert.throws(() => bridge.sendToBoundFeishu(principal, { ...mirror.input, text: 'changed' }), /source_already_reserved/);
      assert.throws(() => bridge.sendToBoundFeishu(principal, { ...mirror.input, source_role: 'assistant' }), /source_already_reserved/);
      await bridge.pump(); assert.equal(sends, 0);
    } finally { store.close(); }
  } finally { f.cleanup(); }
});

test('schema 2: child-first FK ordering and any failure roll back all earlier deletions', () => {
  const f = synthetic();
  try {
    f.inbox('sent', true); f.store.db.prepare('INSERT INTO pairs VALUES (?,?,?)').run('MOCK_expired', f.alice.id, f.now() - 1); f.store.close();
    const before = rows(f.path), original = DatabaseSync.prototype.prepare, sequence: string[] = [];
    try {
      DatabaseSync.prototype.prepare = function(sql: string) {
        if (sql.startsWith('DELETE FROM ')) sequence.push(sql.split(' ')[2]!);
        if (sql.startsWith('DELETE FROM inbox ')) throw new Error('MOCK injected write failure');
        return original.call(this, sql);
      };
      assert.throws(() => runMaintenance(['purge'], f.path, f.now()), /MOCK injected/);
    } finally { DatabaseSync.prototype.prepare = original; }
    assert.deepEqual(sequence, ['pairs', 'content_dispositions', 'jobs', 'inbox']);
    assert.deepEqual(rows(f.path), before);
    assert.equal(runMaintenance(['purge'], f.path, f.now()).counts!.inbox, 1);
  } finally { f.cleanup(); }
});

for (const version of [1, 2, 3] as const) test(`schema ${version}: revoke validates first, is atomic, and never recovers sending work`, () => {
  const f = synthetic(), owner = 'a'.repeat(64);
  try {
    f.inbox('sending'); if (version >= 2) { f.mirror('pending'); f.mirror('sending'); f.mirror('uncertain'); }
    for (const table of ['bindings', 'inbox', 'pairs', ...(version >= 2 ? ['mirror_outbox'] : [])]) f.store.db.prepare(`UPDATE ${table} SET owner=?`).run(owner);
    f.store.db.prepare('INSERT INTO pairs VALUES (?,?,?)').run('MOCK_revoke_pair', owner, f.now() + DAY);
    f.downgrade(version); f.store.close();
    const before = rows(f.path); runMaintenance(['revoke', owner, '--dry-run'], f.path, f.now()); assert.deepEqual(rows(f.path), before);
    const original = DatabaseSync.prototype.prepare;
    try {
      DatabaseSync.prototype.prepare = function(sql: string) { if (sql.startsWith('DELETE FROM pairs')) throw new Error('MOCK revoke failure'); return original.call(this, sql); };
      assert.throws(() => runMaintenance(['revoke', owner], f.path, f.now()), /MOCK revoke failure/);
    } finally { DatabaseSync.prototype.prepare = original; }
    assert.deepEqual(rows(f.path), before);
    assert.equal(runMaintenance(['revoke', owner], f.path, f.now()).event, 'account_revoked');
    const after = rows(f.path); assert.equal((after.bindings as { active: number }[])[0]!.active, 0); assert.deepEqual(after.pairs, []);
    assert.equal((after.jobs as { state: string }[])[0]!.state, 'sending');
    if (version >= 2) assert.deepEqual((after.mirror_outbox as { state: string }[]).map(r => r.state), ['cancelled', 'sending', 'uncertain']);
    runMaintenance(['revoke', owner], f.path, f.now()); assert.deepEqual(rows(f.path), after);
  } finally { f.cleanup(); }
});

test('invalid invocation/path cannot initialize a database; CLI errors reveal no stored content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-maintenance-path-'));
  try {
    const missing = join(dir, 'new-directory', 'missing.sqlite');
    for (const args of [[], ['invalid'], ['purge', 'extra'], ['revoke'], ['revoke', 'invalid'], ['purge', '--dry-run', '--dry-run'], ['--dry-run', 'purge']]) assert.throws(() => runMaintenance(args, missing), /Usage:/);
    for (const path of [undefined, '', ':memory:', 'file:MOCK?mode=rwc', missing, dir]) assert.throws(() => runMaintenance(['purge'], path));
    assert.deepEqual(readdirSync(dir), []); assert.equal(existsSync(missing), false);
    const empty = join(dir, 'empty.sqlite'), bad = join(dir, 'bad.sqlite'), link = join(dir, 'link.sqlite');
    writeFileSync(empty, ''); writeFileSync(bad, 'MOCK private body is not a database'); symlinkSync(bad, link);
    for (const path of [empty, bad, link]) assert.throws(() => runMaintenance(['purge'], path));
    assert.equal(readFileSync(empty).length, 0); assert.equal(readFileSync(bad, 'utf8'), 'MOCK private body is not a database');
    const child = spawnSync(process.execPath, [resolve('dist/scripts/maintenance.js'), 'purge'], { env: { PATH: process.env.PATH, DATABASE_PATH: bad }, encoding: 'utf8' });
    assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.match(child.stderr, /maintenance_failed/); assert.doesNotMatch(child.stderr, /MOCK private|bad.sqlite/);
    assert.deepEqual(parseRequest(['revoke', 'a'.repeat(64), '--dry-run']), { operation: 'revoke', owner: 'a'.repeat(64), dryRun: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, sql] of [
  ['future version', 'PRAGMA user_version=99'], ['unversioned', 'PRAGMA user_version=0'],
  ['missing table', 'DROP TABLE content_dispositions'], ['missing index', 'DROP INDEX binding_owner'],
  ['unexpected trigger', 'CREATE TRIGGER MOCK_bad AFTER DELETE ON pairs BEGIN DELETE FROM receipts; END'],
  ['unknown state', "UPDATE jobs SET state='MOCK_UNKNOWN'"], ['invalid timestamp', "UPDATE inbox SET timestamp='MOCK_invalid'"],
  ['invalid payload', "UPDATE jobs SET payload='MOCK_private_invalid'"], ['nonobject payload', "UPDATE jobs SET payload='null'"],
  ['invalid identity', "UPDATE inbox SET openId='ou_MOCK_wrong'"], ['invalid counter', "UPDATE jobs SET attempts=-1"],
  ['missing receipt', 'DELETE FROM receipts'], ['orphan FK', "PRAGMA foreign_keys=OFF; UPDATE jobs SET inboxId='evt_MOCK_missing'"],
] as const) test(`fails closed on ${name}, with no recovery, migration or partial cleanup`, () => {
  const f = synthetic();
  try {
    f.inbox('sent', true); f.inbox('sending'); f.mirror('sending'); f.store.close(); alter(f.path, sql);
    const before = rows(f.path), bytes = readFileSync(f.path);
    for (const args of [['purge'], ['purge', '--dry-run']]) assert.throws(() => runMaintenance(args, f.path, f.now()));
    assert.deepEqual(rows(f.path), before); assert.deepEqual(readFileSync(f.path), bytes);
  } finally { f.cleanup(); }
});
