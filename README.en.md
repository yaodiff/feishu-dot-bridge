# Feishu ↔ your dot

Connect your own Feishu bot's private chat to your existing dot. Run one bridge per person on a host you control, with your own Feishu app, private database and official OpenAI Tunnel. This repository does not operate a hosted service or public signup platform.

[中文](README.md) · [Deployment](docs/DEPLOYMENT.md) · [Security](SECURITY.md) · [Acceptance checklist](docs/ACCEPTANCE.md)

## Features

- One installation, fixed owner, Feishu app/tenant, current paired DM and active event subscription
- Official SDK WebSocket ingress, one-use pairing, authenticated MCP tools and signed event callbacks
- Ordinary text and bounded rich-post flattening, including duplicate `content_v2` alias suppression; links remain text and are never automatically visited
- Owner-scoped event recovery reads, replies to the original message and authorized, source-labeled ChatGPT text copies to the current bound DM
- Durable inbox/outbox, deduplication, bounded retries, explicit delivery states and a heuristic credential-text omission gate
- Opt-in PNG/JPEG intake, including up to four embedded post images, locally decoded, stripped of metadata and re-encoded
- Explicit managed-proxy transports, callback connection reuse and offline maintenance

Text mode exposes 9 MCP tools. `FEISHU_MEDIA_INPUT=images-v1` adds `get_event_image`, with optional 1-based `image_index`. Audio, transcription, model runtimes and outbound media are not supported.

## Experimental status and hosting

Short live tests have observed ordinary text flowing in both directions and recovery reads. They do not certify 24/7 reliability. Each installation must validate sustained event handling, actual host image ingestion, real callback-pool benefit, restart recovery and account/product compatibility. `sent` means the remote API accepted a message, not that a client displayed or read it; callback 2xx does not prove dot processed it.

Use a long-running host with persistent disk, outbound HTTPS and WebSocket access, process supervision, private backups and failure/capacity alerts. Run one bridge process per database and one consumer per Feishu app, or integrate into its existing consumer. The [official OpenAI hosting guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#choose-where-to-run-tunnel-client) places the Tunnel client in the private MCP server's trust boundary and describes VM/systemd and Kubernetes deployments.

Development tests on October 8–9, 2026 encountered disappearing dot cloud sessions and network-policy denials. These are observed constraints of those environments, not a universal permanent product limitation or a guarantee about long-running hosting or storage durability.

Feishu WebSocket ingress alone needs no public HTTPS Feishu event callback. Feishu API calls still need credentials, permissions and outbound connectivity. Tunnel, public MCP and OAuth have separate access requirements; see [deployment](docs/DEPLOYMENT.md).

## Quick check and setup

Text runtime: POSIX host (Linux/macOS), Node.js 24+ and npm. Image runtime additionally requires Linux `/usr/bin/prlimit` and pinned `sharp` 0.35.5; missing decoder/resource limits fail startup without an unrestricted fallback.

```sh
npm ci --ignore-scripts
npm test
npm run demo
npm run init:personal
```

The full test suite additionally requires Linux, `/usr/bin/prlimit`, `openssl` and `mkfifo`, including image, maintenance and transport checks. macOS text-runtime support does not imply full-suite support there.

Tests/demo use synthetic credentials and simulated services, including loopback TCP/TLS fixtures; they do not contact real Feishu or dot accounts. Initialization runs only when requested, creates private configuration and unique keys, and refuses existing `.env`, `config` or `data`.

1. Fill your verified Feishu app/tenant and existing App Secret locally; confirm exclusive event consumption before enabling `websocketExclusiveConsumer`
2. Start `node --env-file=.env dist/src/main.js` on exact loopback
3. Configure your owner-only official Tunnel to `http://127.0.0.1:3000/mcp` with a local `X-Bridge-Token` header, following [deployment](docs/DEPLOYMENT.md)
4. Connect your existing dot, verify callable tools, pair in your bot DM, then authorize the subscription and reply/mirror scope

UI authentication “None” means no separate OAuth flow. Backend authentication remains mandatory, and anyone who can use the Tunnel is treated as the installation owner. Never share this personal connection. Setup does not create a Tunnel, Feishu app, OAuth grant or platform permission.

## Safety and limits

- Personal mode enforces `127.0.0.1` or `::1`; no default key or authentication bypass. [OAuth compatibility](docs/OAUTH_COMPATIBILITY.md) is explicit and optional
- The installation ID fixes the owner. Static credentials do not expire hourly; request/subscription authorization leases last at most one hour
- Text credential detection can miss secrets or flag ordinary text. Image sanitization cannot identify secrets in pixels or authorize sensitive disclosure
- Database message bodies are not application-encrypted. Protect disks and backups; keep production secrets, messages and databases out of source control
- Ignoring `.private/` is neither encryption nor removal of already tracked files or Git history
- Back up consistently before schema v2 upgrades. Prefer a fix-forward that preserves delivery state; do not point older binaries at an upgraded database
- Reconcile `uncertain` outcomes before retrying. Unlinking cannot recall in-flight sends, and cross-service exactly-once delivery is not promised
- [Linux-only offline maintenance](docs/OFFLINE_MAINTENANCE.md) removes eligible old inbox history but retains all deduplication receipts and mirror rows/bodies. It is not full 30-day retention or privacy erasure

No group routing, ISV distribution, native user-bubble copying, edit/delete/read synchronization, history backfill, full-media mirroring or multi-replica HA. No native ChatGPT message-capture hook, general launcher or session supervisor is supplied; callers must implement authorized text mirroring through their supported interfaces.

## Further documentation

[Owned reads](docs/OWNED_EVENT_READS.md) · [Text mirroring](docs/TEXT_MIRROR_V1.md) · [Images](docs/MEDIA_INPUT_CANDIDATE.md) · [Rich posts](docs/RICH_POST_INPUT.md) · [Callback proxy](docs/CLOUD_PROXY_CANDIDATE.md) · [Callback pool](docs/CALLBACK_POOL_CANDIDATE.md) · [Feishu proxy](docs/FEISHU_MANAGED_PROXY.md) · [Protocol](docs/PROTOCOL.md)

## Licensing

Project source is [MIT](LICENSE). `sharp` is [Apache-2.0](https://github.com/lovell/sharp/blob/main/LICENSE); upstream libvips is [LGPL-2.1-or-later](https://github.com/libvips/libvips/blob/master/LICENSE). Prebuilt packages have separate declarations: the [lockfile](package-lock.json) pins `@img/sharp-libvips-linux-x64` 1.3.4 as `LGPL-3.0-or-later`; other platform packages may use their own or composite license expressions. Follow the exact installed package declarations and notices. Before distributing installed dependencies, containers or other binary artifacts, review included third-party licenses, notices and applicable source/relinking obligations. The whole binary bundle is not MIT-only. Native dependency binaries are not bundled in this source repository.
