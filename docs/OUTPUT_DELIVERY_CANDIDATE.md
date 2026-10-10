# Explicit image and status delivery candidate

This candidate implements caller-submitted outputs to the authenticated owner's existing Feishu private-chat binding. It does **not** observe every dot answer, permission request or approval. There is no verified personal-dot event API in this integration. A caller must submit each authorized update and reconcile its delivery. No new event types or automatic historical replay are introduced. Voice is excluded.

## Tools and media handoff

1. Get the current `binding_id` from `binding_status`.
2. An authorized artifact adapter on the generating side obtains **the actual bytes of the current user-requested generated image**. It must validate the authorized conversation and observed stable `source_message_id`, exclude unrelated images, identity documents and credentials, and attest `source=current_generated_image`, `existing_user_authorization=true`, and actual `generated_at`. These assertions are caller responsibility; the bridge cannot cryptographically prove the image's source or semantic authorization.
3. Compute SHA-256 of the original bytes. Call `stage_generated_image_chunk` through the existing authenticated MCP Tunnel with canonical base64 chunks, each at most 96 KiB decoded, 0-based `chunk_index`, fixed `total_chunks`, SHA, MIME, time and source ID. A 4 MiB image needs at most 43 chunks. Single-block messages stay below the existing 256 KiB HTTP/MCP envelope cap. This stage has no external side effect.
4. Call `send_generated_image_to_feishu` using `transfer_id`, `binding_id` and a stable `request_id`. It reserves the output and consumes that transfer once. Check `output_delivery_status`, then scan `list_output_alerts` at task end. Pending is not API acceptance. `image_key` proves the recorded upload response; `message_id` plus `state=sent` proves recorded message API acceptance, not client visibility.

There is no HTTP URL downloader or local file-path parameter in this path. A private image link, a Markdown image or a text description is insufficient. Do not ask an LLM to reconstruct missing base64. A generating tool's trusted local artifact output can supply bytes to an adapter in its existing authorized environment; only those bytes cross the Tunnel. If the current dot toolset exposes no byte export/read seam for its current generated artifact, image delivery remains blocked until such an adapter exists. This candidate does not claim that the current dot already has that capability. It needs no new browser-control permission.

PNG/JPEG only; maximum 4 MiB input and sanitized output, 20 million pixels, maximum input dimension 8192. The existing Linux `prlimit` decoder strips metadata, orients, caps output to 4096 per dimension and re-encodes PNG. The Feishu upload endpoint supports other formats and a larger 10 MB ceiling; this bridge intentionally stays stricter. At most two live transfers per owner and sixteen globally, 32 outstanding output reservations per owner, fifteen-minute generation lifetime, and principal expiry are enforced. Source/request conflicts fail rather than replace bytes. SQLite stores chunks and queued payloads encrypted with the existing storage key. Active worker cleanup discards expired/consumed/unlinked staging bytes and terminal payloads while retaining dedupe and receipt metadata; this is not forensic erasure of SQLite WAL/backups.

## Status cards

`submit_feishu_status` accepts stable `task_id` and `request_id`, `expected_revision`, `summary`, and `status` (`processing`, `waiting_confirmation`, `completed`, `failed`, `blocked`). Explicit send authorization is required. Waiting also requires `action` and `reason`; failed/blocked require a reason. Plain text rendering prevents caller Markdown from injecting interactive links. Suspected credentials are rejected before card storage.

The first submission sends an interactive JSON 2.0 card. Ordinary progress/completion/failure changes PATCH the latest API-accepted card in that task. Every distinct waiting-confirmation submission sends a new important notification card. Repeating the same request and exact body is deduped. A changed body with the same request ID fails; stale revisions and updates after an unresolved predecessor fail. Explicit terminal or uncertain failures require human reconciliation, not a new ID invented to force a resend. A resolved/new activity may use a new observed task ID; do not use this to disguise replay.

The title and message summary name the status. The wait button has only `open_url`, no callback/value/allow action. It opens the verified official ChatGPT homepage and instructs the user to open dot → Activity and respond in the actual request. It does **not** grant dot permission or claim to target a specific approval. The official control documentation verifies the Activity workflow; a precise account-specific dot/approval deep link was not available to this candidate. Parent review should substitute an already independently verified official dot entry if required, never a guessed route or caller-controlled URL. Mobile web dot availability is limited by the official product; use the ChatGPT app when necessary.

Cards/images have their own output ledger. They do not fabricate text replies, mark an inbox event handled, or satisfy `covered_by_reply`. Continue to claim/reconcile every original event through the existing schema4 handling workflow.

## Durability and failure checks

Schema5 adds `output_outbox`, `output_media`, `output_chunks`. Prior reply/handling/mirror reservations are preserved without backfill sends. New records have durable state, phase, attempt count, revision, completion time and bounded provider receipt IDs. Output operations make **one** attempt. Network/receipt ambiguity becomes `uncertain`, with no worker replay. An interrupted `sending` record becomes `uncertain` at restart, even for PATCH or an already uploaded image. Known nonzero upload/message/PATCH provider codes become `failed`; malformed/missing receipts cannot report success. The generic official SDK request preserves the upload response envelope for explicit code checks; a missing upload key is conservatively uncertain. Upload acceptance alone never marks the output sent.

`list_output_alerts` returns metadata for every non-sent output, including pending, cancelled, failed, blocked and uncertain. Follow `next_after_seq`, even for an empty filtered page, then restart at zero at task end so changed earlier rows are checked. Unlink/revoke prevents pending sends and deletes staging chunks. Authorization and the active binding are rechecked after decode and upload before message send. An already in-flight network call cannot be recalled by unlink; its eventual accepted result remains recorded against the old binding and inaccessible through a new binding.

Offline maintenance recognizes exact schema5, preserves output reservations/tombstones and deletes eligible staging chunks. It never recovers/replays sending work. Do not downgrade schema5 in place to an older binary; prefer a reviewed fix-forward and preserve uncertain/reservation records. An authorized snapshot restore loses subsequent reservations and cannot recall accepted remote messages.

## Deployment review checklist

No production rollout, permission change, restart, push, merge or real send was performed for this candidate. Review its diff against the exact supplied base and preserve private deployment networking outside the generic commit. On an approved rollout: back up the stopped single-worker database; apply the schema5-capable candidate; run the full synthetic suite on Linux including real decoder and offline-maintenance tests; validate the installed SDK's bounded image POST body allowance; then start one worker.

Status cards reuse the existing bot message-send permission (`im:message:send_as_bot`); no new callback authorization capability is needed. Before enabling `FEISHU_IMAGE_OUTPUT=on`, verify the app has the upload-image API's required resource permission (the official permission table is the authority), bot capability and existing bound-message send permission. This candidate did not inspect or modify app grants. Keep output images off until real decoder preflight and the dot artifact-byte handoff are validated. Separately authorize a live synthetic-image upload/send and card send/PATCH smoke test to the user's existing bound DM; inspect actual receipts and client visibility. No arbitrary external recipient is configurable.

## Sources

- [Upload image](https://open.feishu.cn/document/server-docs/im-v1/image/create) — multipart `image_type=message`, `image_key`, size/type limits; also checked against the pinned official SDK 1.74.0 declarations and implementation.
- [Send message](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [Update sent card](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)
- [JSON 2.0 card structure](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)
- [Button](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)
- [Plain text](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/plain-text)
- [Official dot controls](https://learn.chatgpt.com/docs/dots/controls) — approvals are handled in the actual Activity request.
- [Official dot setup](https://learn.chatgpt.com/docs/dots/getting-started) — desktop/mobile-app entry, mobile-web limitation.

## Local candidate validation

- TypeScript build and `git diff --check` pass.
- New synthetic output/official-SDK transport tests: 17 pass. These cover image bytes, encryption, dedupe/conflicts, JPEG chunks, upload versus message receipts, wait notification/PATCH behavior, revocation, uncertain restart, receipt-persistence failure, binding changes during decode, the real bridge worker, MCP visibility and schema5 exact maintenance layout. Sharp is used on original synthetic pixels through an explicit test decoder seam; no production decoder fallback is added.
- Final focused output + existing handling/receipt/text/MCP regressions: 61 pass, 1 Linux-only test skipped.
- Complete serial regression run on macOS with OpenSSL 3: 408 tests, 353 pass, 48 skipped, 7 fail. All seven failures exercise real image decoding or image-enabled startup through missing `/usr/bin/prlimit`. Linux `/proc` maintenance tests are among the skips. This is not a fully green deployment gate. Schema5 maintenance scenarios were added and are locally skipped; they must pass on Linux before rollout.
- Five raw JSON cards plus [offline preview](assets/status-cards-preview.png) are supplied for review. The preview is an illustration, not evidence of Feishu acceptance/rendering.
- No production keys, user images, live Feishu calls, deployment permissions, private account IDs, private proxy settings or host paths were introduced.

### Staging quota repair and persistence fault verification

Closed staging records retain their source/binding tombstones for deduplication, but no longer count against staging capacity. Runtime unlink/revoke and offline schema5 revoke atomically close media and delete encrypted chunks. Cleanup closes expired, inactive-binding and revoked-owner media in the same transaction as chunk deletion and pending-output expiry; chunk staging uses the internal transaction body to avoid nested BEGIN calls. Schema remains v5.

Regression coverage includes two staged images followed by unlink/rebind and immediate reuse of both quota slots, old-binding isolation, cleanup/revoke, deletion failure rollback, reservation rollback, and simultaneous receipt/fallback persistence failures after card create, PATCH and image upload. If both writes fail, the reserved row remains sending with one attempt; a subsequent pump cannot select it, and restart recovers it as uncertain without replay. No test uses actual Feishu sends or user media.
