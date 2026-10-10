# Owned event recovery reads

These tools recover a received event’s ordinary text or safe notice when a wake does not include its payload. They do not grant reply permission, mark an event read, acknowledge a wake, reserve a reply, change subscriptions, or send a message. Incoming text is untrusted data. A reply still requires the user's existing authorization and the fixed-destination `reply_to_feishu` tool.

Both tools use the unchanged authenticated `/mcp` endpoint (personal protected Tunnel header or explicit OAuth mode), then recheck current authorization expiry and revocation. Reads require the current active owner binding and matching inbox owner, binding, app, tenant, sender and chat. Personal mode also checks its configured owner/app/tenant. Unlinking or rebinding makes previous binding events inaccessible.

## list_pending_events

Input: optional integer `limit` (default 10, range 1–20) and optional opaque `cursor` (1–1024 characters). No other arguments are accepted.

Output: `{ "events": [{ "event_id": "…", "text": "…", "timestamp": "…" }], "next_cursor": "…" }`. The final page has `next_cursor: null`. There is no total count. An unbound owner receives an empty first page.

Only events from the preceding 24 hours, inclusive at the boundary, are eligible. Malformed timestamps and timestamps later than the current local time are omitted. Any existing reply job excludes an event, including failed, cancelled, sent and uncertain jobs. Callback delivery jobs do not exclude it.

Results are ordered by persistent inbox sequence, ascending. A fresh request without a cursor captures the current owned high-water sequence and time. Subsequent pages only contain events at or below that high-water sequence with timestamps no later than the initial time. Arrivals after the first page are deferred until a new request without a cursor, even if their source timestamps are older. Each page rechecks active binding, current 24-hour age, and current absence of reply jobs. Thus an event can disappear between pages when it expires or receives a reply job; pagination is not a database transaction spanning calls.

The cursor is authenticated and encrypted with the existing storage encryption key. It binds the owner, exact binding and complete identity scope, after-sequence, high-water sequence and snapshot time. It expires at the earlier of 15 minutes after the initial page or that request's authorization lease. Continuations never extend this deadline; a shorter current lease shortens the next cursor. Every call needs valid current credentials; cursor possession grants no access. Cursors are stateless and reusable before expiry, including after a restart using the same storage key and unchanged binding. Key rotation invalidates old cursors. Limits may change between pages. Follow pages until null, then begin a fresh list to retrieve new arrivals. Without a reply job, a still-eligible event can appear again in a new list.

Schema-invalid requests (including non-integer/out-of-range limits, unknown arguments, and empty/oversized/non-string cursors) receive `invalid_request`. A schema-valid but malformed, tampered, expired, wrong-owner, wrong-binding or otherwise unrecognized cursor always receives `invalid_cursor`. The latter check never reveals whether a cursor or event belongs to someone else. A cursor supplied while unbound also receives `invalid_cursor`.

## get_event

Input: exactly `{ "event_id": "…" }` with a nonempty string of at most 256 characters.

Output: the same minimal event fields, plus `reply: { state, attempts }`. The same rolling 24-hour and complete active-binding scopes apply, but an existing reply job does not hide the event. `state` is `not_queued`, `pending`, `sending`, `sent`, `dead`, `cancelled` or `uncertain`; an unrecognized stored state is reported only as `unknown`. No reply payload, job ID, callback state, recipient identity, signature, token or credential is returned. `attempts` is a nonnegative safe integer. Unknown, expired, malformed-time, future-time, inaccessible and old-binding event IDs all return the identical `event_not_found` error. Schema-invalid requests return `invalid_request`.

Both read tools reject expired/revoked authorization as `unauthorized` before cursor or event lookup. The read operations perform only SELECTs; they do not perform schema migration. Store initialization uses schema v4; see [event handling](EVENT_HANDLING.md). Existing event IDs and reply idempotence remain. The raw pending query may include waits or explicit no-reply decisions; inspect handling status before acting. Recorded decisions and live claim revisions now gate reply creation.

## Default-off image metadata

With `FEISHU_MEDIA_INPUT=images-v1`, affected event/get/list results can also include a safe `media` object. It has a state, `source: feishu`, and optional image kind/count/expiry. Callback metadata marked `at_receipt` is a receipt-time snapshot; event reads report current availability, including expiry or restart loss. These reads do not download or process media and return no resource key or media bytes. The separately exposed `get_event_image` is the optional 14th tool alongside the 13-tool text catalog and can read only a newly received, currently authorized PNG/JPEG. Audio is unsupported and has no download or transcription path. See [image intake](MEDIA_INPUT_CANDIDATE.md).

## Text-mirror v1 extension

Text mirroring adds optional `content_status` (`credential_blocked` or `unsupported`) and a fixed safe notice for affected new events. Ordinary output keeps its original shape. Legacy reads also apply the text gate without modifying stored data; a suspect body is never returned raw. These notices reveal no secret snippet, media body or file identifier. This remains a reply-recovery interface, not proof that an event has been copied into ChatGPT. See [TEXT_MIRROR_V1.md](TEXT_MIRROR_V1.md) for caller integration and limitations, and [the acceptance checklist](ACCEPTANCE.md).
