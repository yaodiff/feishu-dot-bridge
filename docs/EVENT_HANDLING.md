# Per-event processing ledger (local candidate)

The inbox, callback transport and reply sender remain separate. A callback 2xx
means notification acceptance, not model processing or a Feishu reply. A dot
answer does not create a reply job. This ledger records decisions and exposes
missing-work alerts; it does not generate answers, send placeholders, wake tasks,
or invent a platform acknowledgement.

## Tools and states

Four authenticated tools use the existing protected MCP endpoint and recheck the
complete current binding identity. No caller-selected owner or destination exists.
The default catalog has 16 tools, including explicit status/output queries. Image input adds one tool; image output adds two separately enabled tools (17 input-only, 18 output-only, 19 with both). See [output delivery](OUTPUT_DELIVERY_CANDIDATE.md); statuses remain caller-submitted and do not approve dot permissions.

- `get_event_handling({event_id})`: read metadata, decision/revision, lease,
  callback acceptance and actual direct or covering reply state. No message text,
  routing identity, raw model output, credentials or task transcript is returned.
- `list_event_alerts({after_seq?, limit?})`: at most 20 inbox entries examined per
  page (default 10); only alerts are returned. Follow `next_after_seq` even on
  empty pages until null. Restart at zero for new or changed states. Queries do
  not acknowledge, reserve, send or renew anything. Paging is live, not a snapshot.
- `claim_event_processing({event_id, request_id, revision, lease_ms?})`: start or
  recover work using the observed revision. Lease 1–300 seconds, default 60,
  capped by the current authorization expiry. The request ID is stored only as a
  digest. Repeating it while the same claim is recorded returns the old lease;
  it does not renew it, even after expiry. A new recovery request needs the
  current revision and cannot preempt a live lease.
- `complete_event_handling({event_id, revision, outcome, ...})`: complete a live
  claim as `waiting_authorization`, `no_reply` with `sending_prohibited` or
  `no_response_needed`, or `covered_by_reply` with `covering_event_id`. There is
  deliberately no `answered_in_dot` or caller-supplied `sent` state.

New events begin `awaiting_processing`. A successful claim changes them to
`processing`. `reply_to_feishu` atomically creates the real outbox reservation
and sets `reply_reserved`. Once claimed, that call must include the current
`handling_revision` and a live lease. Existing callers may still reserve an
unclaimed event directly; that does not create a handling acknowledgement for
any other event. Existing reply-job idempotence and immutable payloads remain.

`waiting_authorization` blocks both ordinary recovery and direct reply creation.
Only an explicit claim with `resume_waiting: "existing_user_authorization"` may
resume it. The caller must have actual user approval; this assertion is not an
authorization grant, and inbound message content cannot supply it. The bridge
cannot independently inspect the caller's task instructions or verify that a
human gave the approval. It enforces the recorded wait and explicit transition.

`no_reply` is terminal and cannot be cleared through these tools, including by a
recovery claim. This conservative rule protects an explicit prohibition. New
user instructions can be processed as new events; do not silently reopen an old
prohibited event or use another send tool to circumvent its decision.

Coverage requires a different event from the same complete current binding, a
direct real reply reservation, and that reply's API-accepted `sent` state.
Pending, sending, uncertain, dot-only and chained coverage cannot close a merged
event. The caller attests that the actual answer covers this event; the bridge
cannot assess semantic completeness. `reply_state_applies_to` names the covering
event. The covered event's original `delivery_status` still says `not_queued`:
no separate reply is fabricated. Self-coverage is refused.

## Executable end-of-task contract

Maintain the full set of observed input `event_id`s when platform work is merged.
For every ID, read handling status and choose exactly one authorized path:

```text
get_event_handling({event_id:E}) -> revision:R
claim_event_processing({event_id:E,request_id:STABLE_TASK_ID,revision:R})
  -> revision:C, lease_until:T

Authorized ordinary answer:
  reply_to_feishu({event_id:E,text:ACTUAL_ANSWER,handling_revision:C})
  delivery_status({event_id:E}) -> inspect pending/sent/uncertain/etc.

Waiting for approval (no send):
  complete_event_handling({event_id:E,revision:C,
                          outcome:"waiting_authorization"})

Explicitly prohibited or no answer needed (no send):
  complete_event_handling({event_id:E,revision:C,outcome:"no_reply",
                          reason:"sending_prohibited"})

Merged answer covering E2 and E3:
  claim each E1, E2, E3 separately
  reply_to_feishu({event_id:E1,text:ACTUAL_COMBINED_ANSWER,
                  handling_revision:C1})
  delivery_status({event_id:E1}) -> require "sent"
  complete_event_handling({event_id:E2,revision:C2,
                          outcome:"covered_by_reply",covering_event_id:E1})
  complete_event_handling({event_id:E3,revision:C3,
                          outcome:"covered_by_reply",covering_event_id:E1})
```

Before ending, call `get_event_handling` for **every** observed input ID:

- `reply_reserved` / `covered_by_reply`: inspect the actual reply state. Pending
  means still queued; uncertain/sending means verify the exact destination before
  any resend. API sent is not client visibility or read confirmation.
- `waiting_authorization`: leave the wait explicit. Do not manufacture an answer
  or silently resume without real user authorization.
- `no_reply`: honor the decision. It is not a sent reply.
- `awaiting_processing`, or processing with expired lease: unfinished work. Claim
  only for processing recovery, re-evaluate original instructions and permissions,
  and then choose an authorized path. Recovery itself sends nothing.
- Live processing: hand off the recorded lease; do not report final completion.

If a merged anchor is not yet sent, leave the other claims unfinished instead of
faking completion. An expired claim needs a new recovery request and revision
before it can be completed. A retry of the same completion is idempotent.

## Alerts and limits

After two minutes without a claim/reply, a current event exposes
`callback_delivered_without_reply` if notification acceptance is recorded, or
`processing_not_started` otherwise. For new notifications, the two-minute grace
starts at first callback acceptance; migrated accepted callbacks use the original
receipt time without inventing a historical acceptance timestamp. Other alerts
include `processing_lease_expired`, `authorization_required`,
`delivery_requires_verification`, and `reply_not_delivered`.

Metadata queries can inspect retained current-binding events beyond 24 hours,
and expose `recovery_available`, but claim, completion and reply retain the existing 24-hour recovery window.
Thus an old alert can remain visible while content recovery is refused. Unlink,
rebind and revocation prevent access. Queries never return old-binding metadata.
The existing `list_pending_events` remains a raw no-reply-job query and can still
include recorded waits or no-reply decisions: consult handling status before
acting. Reading either interface does not authorize a reply.

The bridge does not run an alert dispatcher, poll the platform, repeat callbacks
for processing recovery, or require new platform permissions. An authorized
caller can query these states on an ordinary wake or a separately approved
schedule. There is no usable final-answer hook configured for this personal dot
installation. Enterprise hook interfaces are a separate capability, not an
implemented personal-account adapter. Neither Responses API completion nor a
dot-only answer is substituted for an actual Feishu reply receipt.

## Migration, maintenance and review boundary

Schema 4 adds only `event_handling`. Historical inbox rows with a real reply job
are seeded `reply_reserved`; others are `awaiting_processing`. No no-reply,
approval, processed decision or callback time is invented. No network calls or
new reply jobs are made. A sending reply still recovers as uncertain; callback
and mirror recovery are unchanged. Claims, waits, prohibitions and coverage
persist across restart, with lease expiry determined by wall clock.

Take a consistent private backup and stop the single consumer before a reviewed
deployment. Older binaries reject schema 4. Do not restore an old snapshot and
replay accepted sends. This generic source candidate remains local and unpublished;
the bounded installation check below is not a publication or reliability certification.

Exact-schema Linux offline maintenance recognizes v1–v4. Schema 4 cleanup retains
unresolved awaiting/processing/waiting events, outstanding jobs and uncertain
results even when older than 30 days. An anchor is retained while a covered event
is retained. Eligible ledger rows cascade only with their eligible inbox rows;
source deduplication receipts remain. No maintenance invocation is scheduled.

Synthetic tests cover the missing-reservation gap, leases and stale writers,
merged coverage, explicit waits/prohibitions, repeats, uncertain sends, atomic
failures, current binding/auth boundaries, migration, restart, MCP contracts and
offline retention. They do not certify platform task routing, model compliance,
semantic answer coverage or continuous availability.

## Live merged-text check (2026-10-10)

A coordinating session reported a real integration check using the refreshed
14-tool catalog. Two newly received text inputs at 09:07:57 and 09:08:02 UTC
were each claimed at revision 1, then synchronized to dot. The caller submitted
one combined reply against the first input. At 09:09:01 UTC the bridge
`delivery_status` recorded `sent` and `attempts: 1`, based on Feishu API
acceptance. Only after that result, the second input was
completed as `covered_by_reply` at revision 2. A subsequent handling check
reported neither input as unfinished or alerted. No second reply was created
for the covered input. See [acceptance boundaries](ACCEPTANCE.md#live-merged-text-check-2026-10-10).

This observes the real claim → caller reply → API acceptance → coverage path
for one merged pair. The caller still judges semantic coverage; API acceptance
is not client display/read confirmation. It does not test prolonged uptime,
forced disconnect recovery, all error paths, autonomous model behavior or
comparative stability against cloud hosting. Replies still require dot's send
tool call. Missing-work checks run when the caller is awakened, not in an
independent all-day monitor, and cannot automatically resend an uncertain reply.
Earlier pending inputs already covered by later answers must not be replayed
just because a legacy raw pending list or retained alert still contains them.
