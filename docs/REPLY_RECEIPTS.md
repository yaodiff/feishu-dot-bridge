# Reply receipt metadata

Successful new reply API calls preserve only the returned bounded message ID,
optional root/parent/thread IDs, and API acceptance completion time. The sender
still uses the same message.reply request, target, text and stable UUID; it does
not change reply_in_thread or grant message-read permissions.

delivery_status adds message_id, root_id, parent_id, thread_id and completed_at
only when recorded. completed_at means the bridge received a successful API
response, not that the Feishu client displayed or read the message. Exact reply
IDs allow an operator with existing permissions to investigate the precise
message without scanning a chat.

The additive schema v3 migration leaves historical receipt fields NULL. It never
backfills them by reading or resending messages. Missing or malformed optional
API metadata does not turn an accepted send into a retry. If persisting a
successful reply fails, it attempts to mark the reservation uncertain. If that
fallback also fails, the database retains sending; startup converts every sending
reply to uncertain rather than pending, so storage recovery cannot replay it.
This conservatively includes a crash after reservation but before API completion.
Existing uncertain jobs remain terminal. Callback notification recovery remains
at-least-once and is not changed. No raw response, content, token or
additional sender/recipient personal data is recorded in these new fields.

Deployment requires a consistent private backup and controlled restart after
review. New code supports schema 1/2 upgrades and exact schema 3 offline
maintenance. Old v2 runtime binaries refuse schema 3; do not roll them back onto
the upgraded database or restore an old snapshot and replay accepted sends.
This observability change does not diagnose or fix client display behavior.
