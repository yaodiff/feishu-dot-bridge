import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Binding, Subscription, Inbox, Job } from './types.js';
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
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
      PRAGMA user_version=1;`);
    // One process/worker per database: a crash can leave an accepted remote send uncertain.
    // Keep the same event ID / Feishu uuid on recovery; never mint a fresh ID.
    this.db.exec(`UPDATE jobs SET state='pending' WHERE state='sending'`);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  binding(owner: string): Binding | undefined { return this.db.prepare('SELECT * FROM bindings WHERE owner=? AND active=1').get(owner) as Binding | undefined; }
  bindingById(id: string): Binding | undefined { return this.db.prepare('SELECT * FROM bindings WHERE id=? AND active=1').get(id) as Binding | undefined; }
  subscription(id: string): Subscription | undefined { return this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id) as Subscription | undefined; }
  inbox(id: string): Inbox | undefined { return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as Inbox | undefined; }
  job(id: string): Job | undefined { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job | undefined; }
  isRevoked(owner: string): boolean { return !!this.db.prepare('SELECT owner FROM revoked WHERE owner=?').get(owner); }
  revoke(owner: string) { this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO revoked(owner) VALUES (?)').run(owner); this.db.prepare('UPDATE bindings SET active=0 WHERE owner=?').run(owner); this.db.prepare('UPDATE subscriptions SET active=0 WHERE owner=?').run(owner); this.db.prepare('DELETE FROM pairs WHERE owner=?').run(owner); }); }
  close() { this.db.close(); }
}
