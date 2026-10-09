# Optional image intake

Images are disabled by default. Set `FEISHU_MEDIA_INPUT=images-v1` only when image processing and disclosure through the existing private MCP connection are authorized. Missing/`disabled` keeps the 9-tool text interface; `images-v1` adds `get_event_image` and safe image metadata. Other values fail closed.

The runtime supports PNG/JPEG images only. It has no audio decoder, transcription adapter, model runtime or outbound-media tool. Audio messages produce unsupported notices, without retaining audio references, downloading bytes or requesting a token for audio retrieval. A callback-backed unsupported notice can survive restart; polling-only audio uses the ordinary unsupported text and generic `media_not_available` metadata.

## Data path and ownership

Authenticated Feishu event → exact current owner/binding checks → durable inbox and safe notice → authorized `get_event_image` → fixed message-resource HTTPS route → local decode/re-encode → source-labeled MCP image.

- Only user-authored events from the currently paired private chat can register references
- Input is `event_id` plus optional 1-based `image_index` (1–4, default 1); never a URL, resource key, path, provider or recipient
- Owner, binding, app, tenant, sender, chat and original message ID are rechecked after asynchronous work before returning pixels
- Only messages created after this process's activation are eligible; no historical fetch/backfill
- References live only in memory for at most 15 minutes and disappear on restart; duplicates cannot replace them or renew expiry
- At most 128 image references, two concurrent reads and one read per event
- Image keys/bytes are not stored in SQLite, callbacks, text results or logs
- Safe callback metadata is an `at_receipt` snapshot, not a current availability or processing guarantee; `get_event` reports current status
- [Rich posts](RICH_POST_INPUT.md) can hold up to four separately selected embedded images; they are not automatically downloaded

No image-specific schema migration is required. Polling-only post notices use a non-deliverable metadata row; ordinary image events without a subscription may have only a generic unavailable notice after restart. Metadata never restores expired references.

## Runtime and decoder

The pinned decoder is `sharp` 0.35.5. Only PNG/JPEG buffer loaders are enabled; file/URL/SVG loaders are not accepted. Input is fully decoded, oriented, converted to sRGB and re-encoded as PNG with alpha retained and metadata removed. Output is resized to fit 4096 × 4096 without enlargement.

A fresh child receives bytes over IPC and a minimal environment, without application credentials, inherited Node options or a caller-selected command. Linux `/usr/bin/prlimit` is mandatory:

- Data limit: 1 GiB; CPU: 8 seconds; open files: 64
- Regular-file output size and core dumps: zero
- Node: JIT disabled, 128 MiB V8 heap limit
- Parent wall-clock decode timeout: 8 seconds; libvips processing timeout: 6 seconds
- Temporary-file environment points to `/dev/null`

A generated one-pixel preflight runs before main reads configuration/credentials or opens the database. Missing native dependencies, unsupported Linux limits or failed decoding stop startup. There is no unrestricted fallback. These are resource bounds, not filesystem/network namespace isolation; the child still runs as the same OS user. A hardened host/container and cgroup memory limits are appropriate additional controls.

## Input and transport bounds

- Input/output: 4 MiB each; PNG/JPEG input, PNG output
- Source: at most 8192 pixels per dimension and 20 million pixels
- Fixed configured Feishu/Lark API host and original message-resource path; no caller URL, redirect or compressed HTTP response
- Response headers: 16 KiB; declared and streamed byte limits both enforced
- Entire media read: 15 seconds, including download and decode; slow downloads reduce available decode time
- Cancellation reaches the download and decoder; unbind/revoke/rebind prevents a result from being returned

The output byte limit is an acceptance bound, not a promise that native encoding never allocates a complete buffer. Pixel/channel limits and OS resource limits also apply. No media file is intentionally written. MCP-host conversation retention is separate and cannot be erased by this bridge.

## Safety and acceptance

Full decoding and metadata removal do not detect secrets inside pixels, certify an image harmless or authorize onward sharing. Do not read known identity documents, credentials or other excluded sensitive images through this tool. Incoming pixels and text remain untrusted data.

Run `npm test` and verify a newly sent, harmless PNG/JPEG on the actual installation. A safe notice or an MCP JSON image result alone does not prove the host ingested pixels. Test cancellation, expiry, restart loss, ownership changes and malformed/oversized inputs. Short text integration results are not image acceptance or a 24/7 reliability claim.

## Dependency licensing

The bridge source is MIT. [sharp is Apache-2.0](https://github.com/lovell/sharp/blob/main/LICENSE), while [upstream libvips is LGPL-2.1-or-later](https://github.com/libvips/libvips/blob/master/LICENSE). The prebuilt package has its own declaration: [package-lock.json](../package-lock.json) pins `@img/sharp-libvips-linux-x64` 1.3.4 as `LGPL-3.0-or-later`. Other platform bundles can use different or composite expressions and contain additional components. Follow the exact installed package declarations and notices; the upstream libvips license alone does not describe the whole native bundle. Before shipping a container, bundled executable or dependency archive, review the exact included binaries and preserve required notices and applicable source/relinking provisions; the entire bundle is not MIT-only. Native binaries are not checked into this source repository.
