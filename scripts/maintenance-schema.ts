import { outputSchema } from '../src/output-schema.js';
import { handlingSchema } from '../src/handling-schema.js';
/** Exact supported offline schema descriptions, never executed against the target.
 * Keep fail-closed: a new runtime schema requires separate maintenance review. */
export const schema1 = `
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
`;
export const schema2 = schema1 + `
CREATE TABLE IF NOT EXISTS content_dispositions (eventId TEXT PRIMARY KEY REFERENCES inbox(id), status TEXT NOT NULL CHECK(status IN ('credential_blocked','unsupported')));
CREATE TABLE IF NOT EXISTS mirror_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), appId TEXT NOT NULL, tenantKey TEXT NOT NULL, openId TEXT NOT NULL, chatId TEXT NOT NULL, sourceId TEXT NOT NULL, sourceRole TEXT NOT NULL CHECK(sourceRole IN ('user','assistant')), contentStatus TEXT CHECK(contentStatus IN ('credential_blocked','unsupported')), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, firstAttemptAt INTEGER, accessUntil INTEGER NOT NULL, remoteMessageId TEXT, UNIQUE(owner,bindingId,sourceId));
CREATE INDEX IF NOT EXISTS mirror_pending ON mirror_outbox(state,nextAt,seq);
`;

export const schema3 = schema2 + `
ALTER TABLE jobs ADD COLUMN remoteMessageId TEXT;
ALTER TABLE jobs ADD COLUMN rootMessageId TEXT;
ALTER TABLE jobs ADD COLUMN parentMessageId TEXT;
ALTER TABLE jobs ADD COLUMN threadId TEXT;
ALTER TABLE jobs ADD COLUMN completedAt INTEGER;
`;

export const schema4 = schema3 + handlingSchema;

export const schema5 = schema4 + outputSchema;
