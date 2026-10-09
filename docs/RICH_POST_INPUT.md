# Rich-post input

Authenticated, user-authored Feishu `post` messages from the exact bound private chat are flattened into bounded plain text. This works in default text mode; optional image access still requires `FEISHU_MEDIA_INPUT=images-v1`.

## Text behavior

Titles, row order, empty rows, embedded newlines, text/Markdown/code literals, links, mentions, separators and simple emotion labels are retained as text. Link destinations are displayed, never fetched. Mention names use aliases already supplied in the event; there is no contact lookup. Formatting is not reproduced and content is never executed or treated as routing instructions.

Both direct title/content objects and locale-wrapped objects are accepted. Supplied locale sections retain source order. Unknown or malformed nodes preserve bounded readable text under explicit markers, excluding known resource identifiers/coordinates. Over-limit or unparseable posts produce an omission notice instead of an apparently complete truncated message.

A section's `content_v2` is suppressed only if it is an array structurally equal to that section's `content`. Array order matters; object-key order does not. This narrow alias check prevents duplicate display and duplicate image admission. Different, malformed or other extra fields remain explicitly represented; the full credential scan runs before alias suppression.

## Images

Up to four valid image nodes are admitted in encounter order. Their positions appear as `[图片 1]`, `[图片 2]`, and so on. Disabled, invalid and excess images receive explicit inline notices. An image marker is not proof of a successful download.

`get_event_image({event_id})` still selects the first image. Optional integer `image_index` selects 1–4; an unavailable index fails without fetching. Returned image metadata includes its index/count. Standalone-image output is unchanged. Callers cannot supply resource keys, URLs, alternate messages or recipients.

Every embedded image counts toward the global 128-reference cap. At most two reads run globally and one per event. Every image has the existing 4 MiB, pixel/dimension, decode and timeout limits. Four images require separate calls; none is fetched automatically. See [image intake](MEDIA_INPUT_CANDIDATE.md).

References are in-memory, expire within 15 minutes and are fenced to messages created after process activation. Duplicate events cannot replace references or extend expiry; restart loses access. Previous posts do not gain historical attachment access.

## Credential and control safeguards

Raw content, all parsed strings (including other locales, links, mentions and unknown fields) and final rendered text pass through the credential gate. Suspected credentials or an embedded pairing-code command replace the whole post with the fixed credential omission notice and discard every image reference. A post cannot enter the `/bind` control path; only an exact ordinary-text pairing command can do so.

The heuristic can miss secrets or produce false positives. It does not inspect image pixels. Content never authorizes reply, disclosure, routing or permission changes.

## Parser bounds

- Raw content: 64,000 JavaScript code units; rendered text: 12,000
- Locale sections: 4; rows per section: 128; rendered nodes: 512
- Inspected values: 2,048; nesting depth: 12; mention records: 128
- Retained images: 4

Files, cards, video, audio and unsupported structures are represented by notices, not media processing. Full Feishu rich-content rendering is outside scope.

## Persistence and verification

Inbox rows retain safe flattened text. When a post has image metadata but no active subscription, an atomic metadata-only `media_notice`/`local` row preserves a safe status. It contains no resource identifiers. The scheduler only delivers event/reply jobs, so this row cannot send or trigger a callback. It can report expiry or restart loss, but cannot recover pixels.

Synthetic tests cover text structures, alias equality/differences, malformed/oversized content, credential scans, image indexing, persistence and current-binding checks. Verify the actual callable `get_event_image` schema, then test new ordinary non-sensitive posts on the target host before claiming live multi-image support. The implementation's schema support does not establish live compatibility with every Feishu client or payload variant.
