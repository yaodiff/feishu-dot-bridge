# Protocol and trust boundaries

The default is a personal loopback MCP service behind an owner-only official OpenAI Tunnel. OAuth remains an explicit compatibility mode. Protocols and product interfaces can change; pin dependencies and rerun contract and per-installation tests before upgrading.

## MCP and events

`src/mcp.ts` uses `@modelcontextprotocol/server` v2 with `createMcpHandler`, rejecting legacy requests. The SDK validates modern request envelopes and routing headers. Tools and the `feishu.message.created` event share the authenticated `/mcp` endpoint. The event adapter implements `events/list`, `events/subscribe` and `events/unsubscribe`; it is not an implementation of every event delivery mechanism.

Subscription identity combines authenticated owner, callback URL, event name and normalized `{binding_id}` parameters. Creation verifies current ownership and a signed challenge. Lifetime is bounded by the current authorization lease, at most one hour; a null TTL is not indefinite authorization. No historical replay is offered by subscription creation.

Callbacks use a fresh challenge and Standard Webhooks signatures over exact body bytes. Event IDs are stable through retries. A 2xx response means callback acceptance, not downstream processing. A 410 ends the subscription; nonretryable responses and ambiguous delivery follow the durable queue's bounded state transitions. Reads and delivery status remain separate from authority to reply.

The default callback transport validates exact approved HTTPS hosts and public DNS addresses, pins the connection, validates TLS and rejects redirects. The explicitly selected [managed-proxy transport](CLOUD_PROXY_CANDIDATE.md) instead delegates DNS/upstream address policy to its validated runtime-owned proxy and uses a bounded [connection pool](CALLBACK_POOL_CANDIDATE.md). These are distinct trust models.

## Installation identity

Personal authentication validates the unique 32-byte base64url `X-Bridge-Token` and maps it to an owner derived from stable `INSTALLATION_ID`. The token is static until administratively rotated; each authentication grants only a finite internal lease. Caller-supplied owner fields never select identity.

The Tunnel must be restricted to that owner. Static header injection does not distinguish multiple upstream users. UI `noauth`/“None” describes absence of a separate OAuth flow, not an unprotected backend. Personal mode exposes no OAuth resource metadata and rejects public/OAuth/multi-app settings.

Official Tunnel configuration supports file/env-backed MCP headers on the configured local origin. Forwarded headers can override static headers, which must still fail authentication if wrong. Tunnel control-plane credentials and local bridge credentials are separate. See [official configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md).

OAuth mode derives identity from the verified issuer/subject and enforces token audience, algorithm, scope and expiry. It is not required for personal installs; see [compatibility](OAUTH_COMPATIBILITY.md).

## Feishu ingress and pairing

The personal template explicitly selects the official SDK's authenticated WebSocket channel. Readiness waits for `onReady`, not just resolution of the start call. Temporary disconnection uses the existing SDK client's reconnection; terminal `onError` shuts down ingress and makes main exit unsuccessfully for a host supervisor to handle.

SDK-authenticated events still undergo configured app/tenant, sender and private-chat checks. WS authenticity is not an HTTP signature claim. The internal mapper must never be exposed to arbitrary HTTP JSON. A WS app's HTTP event endpoint returns 404. Existing consumers must compose handlers without replacing unrelated business logic or starting a competing consumer.

Webhook compatibility separately requires encrypted payloads, original-byte signature validation, freshness, verification token and fixed app/tenant checks. Altering/re-serializing the body at a proxy can break verification. Omitted `ingress` in the legacy parser selects webhook; use explicit values in configuration.

Pairing joins control of the authenticated MCP identity with an authenticated Feishu DM through a five-minute, one-use random command. Pairing commands are consumed as controls and never stored as ordinary inbox text. A rich post cannot trigger pairing. Feishu authentication alone is not proof of dot ownership.

Durable receipt identity uses app + tenant + Feishu `message_id`, not a retry-varying transport event ID. Only ordinary safe text, bounded [rich-post text](RICH_POST_INPUT.md) or fixed omission notices enter the inbox. Optional [image intake](MEDIA_INPUT_CANDIDATE.md) uses current-owner short-lived references and reauthorization; no audio processing is present.

## Sending and recovery

`reply_to_feishu` accepts an owned `event_id` and text; its destination is the original inbox message. The same event/exact body returns its existing reply reservation; a conflicting body is rejected. `send_to_bound_feishu` uses a current binding-generation guard and stable source-message ID; the server resolves the bound recipient. Neither tool accepts arbitrary routing.

[Owned event reads](OWNED_EVENT_READS.md) are bounded recovery interfaces, not read receipts or permission to send. [Text mirroring](TEXT_MIRROR_V1.md) explains schema v2, exact-body reservations, retries and cancellation. `uncertain` requires destination reconciliation; a new ID must not be used to force a blind retry.

## Reference and acceptance

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP experimental events proposal](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
- [Official Feishu Node SDK](https://github.com/larksuite/node-sdk)
- [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)

The implementation and synthetic test suite do not establish universal product compatibility, native ChatGPT message capture, 24/7 availability or exactly-once delivery. Use the [acceptance checklist](ACCEPTANCE.md) for actual account, network, host and end-to-end validation.
