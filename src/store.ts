import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Binding, Subscription, Inbox, Job, MirrorJob, ContentStatus } from './types.js';
export interface OwnedEventRow { seq: number; event_id: string; text: string; timestamp: string; content_status?: ContentStatus }
export interface OwnedEventReplyRow extends OwnedEventRow { state: string | null; attempts: number | null }
// Explicitly match every identity column against the current active binding. Never
// trust inbox.owner or a caller-supplied event ID as sufficient authority by itself.
const ownedInbox = `FROM inbox i JOIN bindings b ON b.id=i.bindingId
  WHERE b.active=1 AND b.id=? AND b.owner=? AND b.appId=? AND b.tenantKey=? AND b.openId=? AND b.chatId=?
  AND i.owner=b.owner AND i.appId=b.appId AND i.tenantKey=b.tenantKey AND i.openId=b.openId AND i.chatId=b.chatId`;
const bindingScope = (b: Binding) => [b.id, b.owner, b.appId, b.tenantKey, b.openId, b.chatId];
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, personal?: { owner: string; appId: string; tenantKey: string }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) > 2) { this.db.close(); throw new Error('Unsupported database schema version'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, owner TEXT NOT NULL, appId TEXT NOT NULL, tenantKey TEXT NOT NULL, openId TEXT NOT NULL, chatId TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE UNIQUE INDEX IF NOT EXISTS binding_identity ON bindings(appId,tenantKey,openId) WHERE active=1;
      CREATE UNIQUE INDEX IF NOT EXISTS binding_owner ON bindings(owner) WHERE active=1;
      CREATE TABLE IF NOT EXISTS pairs (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), url TEXT NOT NULL, secret TEXT NOT NULL, oldSecret TEXT, rotateUntil INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), appId TEXT NOT NULL, tenantKey TEXT NOT NULL, openId TEXT NOT NULL, messageId TEXT NOT NULL, chatId TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT NOT NULL, UNIQUE(appId,tenantKey,messageId));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, receivedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, lane TEXT NOT NULL, inboxId TEXT NOT NULL REFERENCES inbox(id), subscriptionId TEXT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', nextAt INTEGER NOT NULL DEFAULT 0, firstAttemptAt INTEGER, accessUntil INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(state,nextAt,seq);
      CREATE TABLE IF NOT EXISTS revoked (owner TEXT PRIMARY KEY);
      `);
    if (personal) { try { this.assertPersonalScope(personal.owner, personal.appId, personal.tenantKey); } catch (error) { this.db.close(); throw error; } }
    // Additive migration only after verifying that the existing database belongs to this installation.
    this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS content_dispositions (eventId TEXT PRIMARY KEY REFERENCES inbox(id), status TEXT NOT NULL CHECK(status IN ('credential_blocked','unsupported')));
      CREATE TABLE IF NOT EXISTS mirror_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), appId TEXT NOT NULL, tenantKey TEXT NOT NULL, openId TEXT NOT NULL, chatId TEXT NOT NULL, sourceId TEXT NOT NULL, sourceRole TEXT NOT NULL CHECK(sourceRole IN ('user','assistant')), contentStatus TEXT CHECK(contentStatus IN ('credential_blocked','unsupported')), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, firstAttemptAt INTEGER, accessUntil INTEGER NOT NULL, remoteMessageId TEXT, UNIQUE(owner,bindingId,sourceId));
      CREATE INDEX IF NOT EXISTS mirror_pending ON mirror_outbox(state,nextAt,seq); PRAGMA user_version=2; COMMIT;`);
    if (personal) {
      if (this.db.prepare('SELECT 1 FROM mirror_outbox WHERE owner!=? OR appId!=? OR tenantKey!=? LIMIT 1').get(personal.owner, personal.appId, personal.tenantKey)) { this.db.close(); throw new Error('Mirror outbox belongs to a different installation'); }
    }
    this.db.exec(`UPDATE mirror_outbox SET state='pending' WHERE state='sending'`);
    // One process/worker per database: a crash can leave an accepted remote send uncertain.
    // Keep the same event ID / Feishu uuid on recovery; never mint a fresh ID.
    this.db.exec(`UPDATE jobs SET state='pending' WHERE state='sending'`);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  binding(owner: string): Binding | undefined { return this.db.prepare('SELECT * FROM bindings WHERE owner=? AND active=1').get(owner) as Binding | undefined; }
  bindingById(id: string): Binding | undefined { return this.db.prepare('SELECT * FROM bindings WHERE id=? AND active=1').get(id) as Binding | undefined; }
  subscription(id: string): Subscription | undefined { return this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id) as Subscription | undefined; }
  inbox(id: string): Inbox | undefined { return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as Inbox | undefined; }
  mirrorJob(id: string): MirrorJob | undefined { return this.db.prepare('SELECT * FROM mirror_outbox WHERE id=?').get(id) as MirrorJob | undefined; }
  job(id: string): Job | undefined { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job | undefined; }
  ownedEventHighWater(binding: Binding): number {
    return Number(this.db.prepare(`SELECT COALESCE(MAX(i.seq),0) AS seq ${ownedInbox}`).get(...bindingScope(binding))!.seq);
  }
  pendingOwnedEvents(binding: Binding, since: number, at: number, after: number, through: number, limit: number): OwnedEventRow[] {
    return this.db.prepare(`SELECT i.seq,i.id AS event_id,i.text,i.timestamp,(SELECT status FROM content_dispositions d WHERE d.eventId=i.id) AS content_status ${ownedInbox}
      AND unixepoch(i.timestamp,'subsec') BETWEEN ? AND ? AND i.seq>? AND i.seq<=?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.inboxId=i.id AND j.kind='reply')
      ORDER BY i.seq ASC LIMIT ?`).all(...bindingScope(binding), since / 1000, at / 1000, after, through, limit) as unknown as OwnedEventRow[];
  }
  ownedRecentEvent(binding: Binding, eventId: string, since: number, at: number): OwnedEventReplyRow | undefined {
    return this.db.prepare(`SELECT i.seq,i.id AS event_id,i.text,i.timestamp,(SELECT status FROM content_dispositions d WHERE d.eventId=i.id) AS content_status,
      (SELECT j.state FROM jobs j WHERE j.inboxId=i.id AND j.kind='reply' ORDER BY j.seq LIMIT 1) AS state,
      (SELECT j.attempts FROM jobs j WHERE j.inboxId=i.id AND j.kind='reply' ORDER BY j.seq LIMIT 1) AS attempts
      ${ownedInbox} AND i.id=? AND unixepoch(i.timestamp,'subsec') BETWEEN ? AND ?`)
      .get(...bindingScope(binding), eventId, since / 1000, at / 1000) as OwnedEventReplyRow | undefined;
  }
  isRevoked(owner: string): boolean { return !!this.db.prepare('SELECT owner FROM revoked WHERE owner=?').get(owner); }
  revoke(owner: string) { this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO revoked(owner) VALUES (?)').run(owner); this.db.prepare('UPDATE bindings SET active=0 WHERE owner=?').run(owner); this.db.prepare('UPDATE subscriptions SET active=0 WHERE owner=?').run(owner); this.db.prepare('DELETE FROM pairs WHERE owner=?').run(owner); this.db.prepare("UPDATE mirror_outbox SET state='cancelled' WHERE owner=? AND state='pending'").run(owner); }); }
  assertPersonalScope(owner: string, appId: string, tenantKey: string): void {
    for (const table of ['bindings', 'pairs', 'subscriptions', 'inbox', 'revoked']) {
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE owner != ? LIMIT 1`).get(owner)) throw new Error('Database contains another owner; use a separate personal database or an explicit reviewed migration');
    }
    for (const table of ['bindings', 'inbox']) {
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE appId != ? OR tenantKey != ? LIMIT 1`).get(appId, tenantKey)) throw new Error('Database belongs to a different app or tenant; no automatic adoption');
    }
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mirror_outbox'").get()) {
      if (this.db.prepare('SELECT 1 FROM mirror_outbox WHERE owner!=? OR appId!=? OR tenantKey!=? LIMIT 1').get(owner, appId, tenantKey)) throw new Error('Mirror outbox belongs to a different installation');
    }
    const active = this.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE active=1 AND expiresAt>?').get(Date.now())!;
    if (Number(active.n) > 1) throw new Error('Personal mode permits only one active subscription');
  }
  close() { this.db.close(); }
}
