/** v5: explicit caller submissions, durable send reservations and encrypted media staging. */
export const outputSchema = `
CREATE TABLE IF NOT EXISTS output_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), requestId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','card')), taskId TEXT, revision INTEGER, targetMessageId TEXT, payload TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled','uncertain','blocked')), phase TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, accessUntil INTEGER NOT NULL, remoteMessageId TEXT, imageKey TEXT, completedAt INTEGER, failure TEXT, UNIQUE(owner,bindingId,requestId), UNIQUE(owner,bindingId,taskId,revision));
CREATE INDEX IF NOT EXISTS output_pending ON output_outbox(state,seq);
CREATE TABLE IF NOT EXISTS output_media (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), sourceId TEXT NOT NULL, digest TEXT NOT NULL, mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg')), generatedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, totalChunks INTEGER NOT NULL CHECK(totalChunks BETWEEN 1 AND 43), consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)), UNIQUE(owner,bindingId,sourceId));
CREATE TABLE IF NOT EXISTS output_chunks (mediaId TEXT NOT NULL REFERENCES output_media(id) ON DELETE CASCADE, part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 42), digest TEXT NOT NULL, encrypted TEXT NOT NULL, PRIMARY KEY(mediaId,part));
`;
export const invalidOutputQueries = [
  "FROM output_outbox o JOIN bindings b ON b.id=o.bindingId WHERE o.owner!=b.owner",
  "FROM output_media m JOIN bindings b ON b.id=m.bindingId WHERE m.owner!=b.owner",
  "FROM output_outbox WHERE (kind='card')!=(taskId IS NOT NULL AND revision IS NOT NULL) OR revision<1 OR attempts NOT IN (0,1) OR (state='sent' AND (remoteMessageId IS NULL OR completedAt IS NULL))",
  "FROM output_outbox WHERE state NOT IN ('pending','sending','sent','failed','cancelled','uncertain','blocked') OR phase NOT IN ('queued','preflight','uploading','uploaded','sending_image','sending_card','patching_card','accepted','cancelled') OR length(digest)!=64 OR digest GLOB '*[^0-9a-f]*'",
  "FROM output_media WHERE totalChunks NOT BETWEEN 1 AND 43 OR consumed NOT IN (0,1) OR mime NOT IN ('image/png','image/jpeg') OR length(digest)!=64 OR digest GLOB '*[^0-9a-f]*'",
  "FROM output_chunks c JOIN output_media m ON m.id=c.mediaId WHERE c.part>=m.totalChunks"
];
