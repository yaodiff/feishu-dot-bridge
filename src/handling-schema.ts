/** Additive metadata only. No answer, credential, task transcript or wake token. */
export const handlingSchema = `
CREATE TABLE IF NOT EXISTS event_handling (eventId TEXT PRIMARY KEY REFERENCES inbox(id) ON DELETE CASCADE, state TEXT NOT NULL DEFAULT 'awaiting_processing' CHECK(state IN ('awaiting_processing','processing','waiting_authorization','no_reply','reply_reserved','covered_by_reply')), revision INTEGER NOT NULL DEFAULT 0, receivedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, leaseUntil INTEGER, claimDigest TEXT, reason TEXT CHECK(reason IN ('authorization_required','sending_prohibited','no_response_needed','combined_reply')), coveredBy TEXT REFERENCES inbox(id), callbackAcceptedAt INTEGER);
`;

/** Shared fail-closed metadata invariants, used at startup and offline review. */
export const invalidHandlingQueries = [
  "FROM inbox i WHERE NOT EXISTS(SELECT 1 FROM event_handling h WHERE h.eventId=i.id)",
  "FROM event_handling WHERE state NOT IN ('awaiting_processing','processing','waiting_authorization','no_reply','reply_reserved','covered_by_reply') OR typeof(revision)!='integer' OR revision<0 OR revision>9007199254740991",
  "FROM event_handling WHERE (state='processing')!=(leaseUntil IS NOT NULL AND claimDigest IS NOT NULL)",
  "FROM event_handling WHERE state='processing' AND (typeof(leaseUntil)!='integer' OR leaseUntil<0 OR leaseUntil>8640000000000000 OR length(claimDigest)!=64 OR claimDigest GLOB '*[^0-9a-f]*')",
  "FROM event_handling WHERE (state='covered_by_reply')!=(coveredBy IS NOT NULL) OR coveredBy=eventId",
  "FROM event_handling WHERE (state='waiting_authorization' AND reason IS NOT 'authorization_required') OR (state='no_reply' AND COALESCE(reason,'') NOT IN ('sending_prohibited','no_response_needed')) OR (state='covered_by_reply' AND reason IS NOT 'combined_reply') OR (state IN ('awaiting_processing','processing','reply_reserved') AND reason IS NOT NULL)",
  "FROM event_handling h WHERE (state='reply_reserved')!=EXISTS(SELECT 1 FROM jobs j WHERE j.inboxId=h.eventId AND j.kind='reply')",
  "FROM event_handling h JOIN inbox i ON i.id=h.eventId JOIN inbox a ON a.id=h.coveredBy WHERE i.bindingId!=a.bindingId OR i.owner!=a.owner",
  "FROM event_handling h WHERE state='covered_by_reply' AND NOT EXISTS(SELECT 1 FROM event_handling a JOIN jobs j ON j.inboxId=a.eventId AND j.kind='reply' WHERE a.eventId=h.coveredBy AND a.state='reply_reserved' AND j.state='sent')"
];
