# Per-installation acceptance

The bridge is experimental. Short live integration checks have observed ordinary text in both directions and owner-scoped recovery reads. Those observations do not establish uninterrupted 24/7 operation, durable hosting, actual image ingestion by every host, or reliable unattended event processing. Tests and the demo use synthetic data and mocked external services unless a test explicitly creates a local TCP/TLS fixture.

October 8–9, 2026 development sessions encountered disappearing dot cloud sessions and network-policy denials. Treat these as observed environmental constraints. Do not generalize them to a permanent product-wide prohibition, and do not treat an available session as a long-running hosting guarantee.

## Required before relying on an installation

- [ ] A long-running host, persistent private disk, outbound HTTPS/WebSocket, process supervision and failure/capacity alerts are verified
- [ ] Fixed installation identity and independent random keys; private file permissions; initialization refuses existing state
- [ ] Personal listener remains exact loopback; missing, wrong, forged and overridden header credentials fail
- [ ] Official Tunnel access is restricted to this owner; Tunnel runtime key and local bridge key are distinct and never logged
- [ ] The actual account supports the selected Tunnel/authentication/MCP Events combination; no authentication is removed to work around a failure
- [ ] All 9 default tools are callable; optional image mode adds `get_event_image` with its current schema, including `image_index`
- [ ] Verified Feishu app/tenant and minimum private-message permissions, with no competing consumer or overwritten existing handler
- [ ] Real WS readiness, temporary disconnect, terminal failure, graceful shutdown and supervised restart are tested
- [ ] Pairing admits only the intended owner's current DM; other users, bots and groups cannot route into it
- [ ] Actual subscription challenge, callback host allowlist, TLS and signing work; replies return only to the original message
- [ ] Reply and mirror scope is explicitly authorized; incoming content cannot change routing, permissions or binding
- [ ] Duplicate events/replies, retry backoff, expiry, unbinding, revocation, key rotation and ambiguous outcomes are exercised
- [ ] Delivery states are checked separately for Feishu and ChatGPT; no callback 2xx, queue acceptance or remote API acceptance is mislabeled as client display/read/processing
- [ ] Authorized native ChatGPT user and assistant text each reach the current bound DM; source-labeled copies are not mirrored back as new inputs
- [ ] Unsupported and suspected-credential notices are visible; false-positive/false-negative limits are understood
- [ ] Private consistent backups, restore/reconciliation and schema v2 fix-forward are tested; one process owns the database
- [ ] [Maintenance limits](OFFLINE_MAINTENANCE.md) are understood, including Linux-only operation and indefinite receipt/mirror retention

## Optional image and rich-post acceptance

- [ ] Explicit image authorization, Linux `/usr/bin/prlimit` and startup decoder preflight are verified
- [ ] A newly sent harmless PNG/JPEG is actually visible to the intended MCP host; metadata or JSON alone is not proof of pixel ingestion
- [ ] New rich posts preserve title, row order, text, links and mentions without opening links; an identical `content_v2` alias renders once
- [ ] Up to four new embedded images can be selected with 1-based indices; invalid indices fail without fetching
- [ ] Expiry, restart loss, cancellation, size/dimension limits and unbinding during a read are verified
- [ ] No known credential/identity-document or excluded sensitive image is used for a test; metadata removal is not a semantic secret detector
- [ ] Audio remains unsupported, with no audio download, transcription or model runtime

## Optional transports and deployment forms

- [ ] If selected, [managed callback proxy](CLOUD_PROXY_CANDIDATE.md) and [Feishu proxy](FEISHU_MANAGED_PROXY.md) use the approved runtime-owned loopback proxy, exact allowed hosts and valid TLS
- [ ] Network policy denials are handled through the environment's supported administration, never by bypassing restrictions
- [ ] Callback pool reuse and latency are measured on the actual path; a synthetic benchmark or reuse count is not a delivery guarantee
- [ ] OAuth identity/expiry/revocation and public reverse-proxy behavior are separately tested if that compatibility mode is used
- [ ] Docker build/runtime are tested on the target platform if used; the included template is not proof of a successful container deployment

## Evidence boundaries

The repository contains regression coverage for authentication, isolation, routing, persistence, content safeguards, owned reads, rich posts, image decoding, proxy/pool behavior and offline maintenance. Run the final checkout's aggregate suite yourself. Passing it does not validate external account permissions, Tunnel access control, Feishu configuration, sustained uptime or another installation.

An acceptance result should record the tested version, host and bounded observation window privately, without publishing credentials, real message bodies, identifiers or delivery receipts. State which checks passed, failed or were not run. Do not call the system production-certified or exactly-once on the basis of a short smoke test.
