# Owner-bound text mirroring

Text mirroring provides a bounded Feishu send capability and safe ingress notices. It does not capture native ChatGPT messages, post messages into ChatGPT, or replicate a complete conversation automatically. The calling integration must use supported interfaces and explicit authorization. See the [acceptance checklist](ACCEPTANCE.md).

## Scope and identity

One authenticated installation owner, their existing active Feishu DM binding, and the existing dot conversation. No arbitrary recipient, group, app, tenant, URL, user impersonation, historical import, or new credential is added by text mirroring. The separate default-off [image-input path](MEDIA_INPUT_CANDIDATE.md) can download and sanitize a newly received owner-bound PNG/JPEG; it does not add media sending or full image mirroring. Feishu copies are authored by the existing app/bot. ChatGPT copies must be posted by dot with clear source attribution; this bridge does not insert native user bubbles.

The bridge enforces the Feishu owner/binding/app/tenant/sender/chat boundary. It cannot independently authenticate a ChatGPT source room or source ID because there is no ChatGPT capture hook in this service. The calling dot must validate that messages came from the single authorized conversation, use observed source IDs, and never mirror already-generated copies back again. The displayed source label is attribution, not authentication or loop prevention.

## Mirror MCP tools

### send_to_bound_feishu

Strict input: binding_id, source_message_id, source_role (`user` or `assistant`), text. All are required; unknown properties are rejected. Source IDs and binding IDs are nonempty, at most 256 characters; text is nonempty, at most 12,000 JavaScript code units.

The binding ID is only a generation guard obtained from binding_status. It must equal the authenticated owner's current binding. The destination is always resolved on the server. A body is wrapped as `[来自 ChatGPT · 你]` or `[来自 ChatGPT · dot]` followed by the original ordinary text. No interpretation, command execution, URL expansion or formatting conversion occurs.

Output contains sync_id, state, attempts, optional content_status and, after confirmed delivery, message_id. `pending` is not delivery confirmation. The same binding/source ID and exact resulting body/role returns the original job; changed body/role returns source_already_reserved. A suspect body becomes a fixed omission notice before it enters the outbox; it is never stored there. Once reserved, that safe notice is immutable for that source ID too.

### mirror_delivery_status

Strict input: sync_id. Reads only the authenticated owner's current exact binding generation, rechecking owner/app/tenant/sender/chat. Unknown, old-binding and inaccessible IDs all return sync_not_found. No body, source ID, recipient details, credential, or callback data is returned. States include pending, sending, sent, uncertain, cancelled and blocked. A blocked legacy/tampered body is not transmitted.

In default text mode the endpoint includes the original nine tools: `begin_binding`, `binding_status`, `unlink_binding`, `reply_to_feishu`, `delivery_status`, `list_pending_events`, `get_event`, `send_to_bound_feishu`, and `mirror_delivery_status`. `reply_to_feishu` also returns optional `content_status` when replacing a suspect reply body. Explicit `FEISHU_MEDIA_INPUT=images-v1` adds `get_event_image` and optional media metadata to the current catalog; image input does not expand the text-mirror tool contracts.

## Ingress omissions and unsupported messages

Authenticated user messages in the exact bound p2p chat remain the only input. Bot, system and group messages are still ignored. Rich posts are flattened into bounded safe text as described in [rich-post input](RICH_POST_INPUT.md). In default text mode, other non-text input produces a safe placeholder with content_status=unsupported; no original media body, file key, filename, URL, or bytes are stored or transmitted. In images-v1 mode, supported images can add safe metadata and short-lived in-memory references; an explicitly authorized get_event_image call may return sanitized PNG bytes. Audio stays unsupported and retains no resource reference. Media bytes and resource keys are not persisted in the bridge database. An unsupported message cannot be used for pairing. Oversized/malformed transport envelopes and invalid message data can still be rejected before a notice is available; no claim of universal capture is made.

Suspected credential text produces content_status=credential_blocked and this fixed message:

`[未同步：消息可能包含登录凭据或其他密钥]`

Unsupported media uses:

`[未同步：暂不支持此消息类型]`

The same minimal content_status is included in event callbacks, get_event and list_pending_events for affected new messages. Ordinary events retain the old shape. Do not silently omit these placeholders in the destination conversation. An exact `/bind` command is passed only to one-use pairing consumption and is never forwarded or put in the inbox.

## Credential safeguards and limits

The classifier is pure, bounded and returns no snippets. It covers recognizable secrets, contextual labels, credentials in URLs, keys, tokens, cookies, payment credentials and login/recovery codes using conservative heuristics and common Unicode/encoding normalization. It is not a perfect secret detector. `ordinary` does not prove that arbitrary passwords, obfuscated secrets or sensitive information are absent. Discussing a password or API without a value should remain ordinary. Synthetic fixtures, hashes and diagnostics are tested, but false positives and false negatives remain possible.

Gates run in normalization, again before inbox/event/outbox persistence, when presenting legacy event reads, and before remote sends. Diagnostic output does not contain message snippets. There is no new text logging. Existing historical database contents are not rewritten or deleted. Legacy queued suspect bodies are blocked rather than silently changing a potentially already-sent payload under the same idempotency key. Their blocked status requires explicit handling; it is not evidence a notice was delivered.

Neither message content nor a source label authorizes changing routes, bindings, permissions, security configuration, or suppression rules. The ordinary-message authorization does not grant permission to transmit credentials or share data to another destination. The calling agent must still apply its semantic and sensitive-data rules before any tool call.

## Persistence, retries and cancellation

Schema v2 adds content_dispositions and mirror_outbox without changing original tables or rows. Existing reply idempotency remains unchanged. Future schema versions are refused. Every mirror job snapshots the full binding identity; no later binding is substituted. Unlink/revocation cancels pending mirrors. Old binding jobs are inaccessible through status after unlink/rebind. A request already sent to Feishu cannot be recalled by unlinking.

The process alternates available existing jobs and mirror jobs to avoid starving either queue. Pending/backoff work blocks later work within its own mirror binding lane. Native reply and mirror lanes can interleave; there is no universal cross-platform ordering promise. One process owns the database, as before.

A stable 32-character UUID is derived from the persistent sync ID. Retries and crash recovery reuse it and the identical body. Eight failed/ambiguous attempts stop as uncertain. Retries stop before 55 minutes from the first attempt, using the bridge's conservative retry window, or when the request authorization lease expires. An unattempted expired job is cancelled; an attempted expired job is uncertain. Repeating the same source call cannot reset attempts or extend its lease. After uncertain outcomes, reconcile the destination rather than minting a fresh source ID and blindly retrying.

## Schema v2 upgrade and recovery

Schema v2 is additive, but this does not make an old executable a safe rollback. Before a separately authorized upgrade, stop the single database-owning process and create a consistent private backup through the installation's approved SQLite backup workflow. Preserve the matching installation identity, storage key and configuration privately; none belongs in source control. Do not copy only a live main database file while a WAL may contain committed work. Source installation alone does not perform a private backup.

Prefer a reviewed fix-forward on the v2-aware code while retaining durable inbox, mirror reservations and delivery states. An older binary can ignore the new tables and retry/cancel semantics, so do not point it at the upgraded live database as a presumed safe downgrade. Restoring a pre-upgrade snapshot loses later records and cannot recall already accepted remote sends; reconcile both destinations and pending/uncertain jobs before any separately authorized restore. Keep one owner process, do not reset source IDs to force retries, and do not drop the new tables or lower `user_version` as a rollback shortcut. Future schema versions are rejected.

## Eligible inbox-history cleanup and retained mirrors

**Maintenance is Linux-only, requires `/proc/self/fd`, owner-only files/private parent directories and a trusted quiescent host; unsupported hosts fail closed. This does not change the bridge runtime’s cross-platform scope.** The current offline maintenance path supports exact known schema 1/2/3/4 without constructing Store, creating a database, migrating tables or recovering sending jobs. `purge` means eligible inbox-history cleanup: old inbox bodies, their terminal jobs and omission dispositions can be removed only when no related pending/sending/uncertain job remains. Foreign-key children are removed before parents; referenced inactive bindings and subscriptions remain. Receipt deduplication reservations remain indefinitely, so removed inbox IDs cannot be re-ingested.

All mirror rows remain unchanged, including terminal bodies, source IDs, routing snapshots, attempt/state metadata and remote message IDs. The existing enqueue contract compares the exact stored body and source role, and schema 2 has no terminal-completion timestamp or separate body-free reservation. Clearing bodies would change exact-repeat behavior; deleting reservations could permit another send after Feishu's deduplication window. Neither change is implemented. Do not claim full 30-day retention or privacy erasure. The command has no automatic schedule and never recalls remote copies or clears backups/filesystem remnants. See [offline maintenance](OFFLINE_MAINTENANCE.md) for dry-run usage and separate deletion requirements.

## Caller integration

This repository exposes bridge tools; it does not capture native ChatGPT messages or supply a platform sender. Use only supported interfaces and the user's explicit mirror/reply authorization. A stable observed source message ID and current binding are required.

1. Start from an explicit activation point for new messages. Track source ID, direction, role, binding generation and each destination's state separately in the calling integration
2. Enqueue an authorized native ChatGPT text copy once, using its actual stable source ID; never mirror a generated copy back as a new input
3. Recover a Feishu event with exact `get_event` or bounded `list_pending_events` when necessary, then present its source-labeled input or safe omission notice
4. Generate one response per original input. Send only to authorized destinations and verify each delivery separately
5. Reconcile ambiguous sends using supported destination reads. If delivery cannot be established, keep it uncertain instead of minting a new source ID and resending
6. Stop dependent work on unavailable connection, changed/expired binding, blocked data, uncertainty or missing authorization

`list_pending_events` is reply recovery, not a record of ChatGPT copies; any reply job removes an event from that list. A delayed callback may arrive after recovery, so deduplicate by event ID. Callback success and Feishu reply state cannot prove delivery into ChatGPT. Cross-platform ordering, native bubbles, edits/deletions/read receipts, streaming and media replication are outside scope.

## Verification

Run the final source's aggregate tests and demo with synthetic fixtures. Short ordinary-text integration observations do not prove uninterrupted event handling, image ingestion or 24/7 hosting. New installations require their own [acceptance checks](ACCEPTANCE.md), including source labels, both text directions, distinct delivery states and no mirror loop. Preserve the existing identity and private state during upgrades, and do not expand account permissions as a troubleshooting shortcut.

Current catalog: four [handling tools](EVENT_HANDLING.md) make 13 text tools or 14 with images. Historical schema v2 details above describe the original text-mirror migration.
