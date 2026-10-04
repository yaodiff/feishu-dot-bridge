# Feishu ↔ personal dot bridge

Experimental self-hosted TypeScript MVP connecting each user's Feishu DM to their **existing personal dot** through authenticated MCP Events and a reply tool. Not an official OpenAI/Feishu project; not production-audited or live end-to-end verified.

## Quick start

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

Requires Node.js 24+. The demo and integration fixtures are MOCK ONLY and make no real account/network calls.

Each user authenticates this MCP resource server through an external OAuth2.1 identity provider. A short-lived, one-use pairing code is consumed only by a authenticated Feishu user DM (encrypted/signed webhook by default, or an explicit official-SDK WebSocket connection). The server binds OAuth issuer+subject to app+tenant+open_id. Each binding supports one active callback subscription. Text events route to that subscription; replies are restricted to the original stored message owned by that account.

Included: official MCP v2 SDK, protocol 2026-07-28, strict JWT/JWKS checks, encrypted Feishu callbacks or optional official-SDK WebSocket ingress, SQLite inbox/outbox, message-id deduplication, bounded retries, Standard Webhooks signing, HTTPS callback verification with DNS pinning/public-IP checks, owner-scoped delivery status, Docker and CI.

Scope: multiple users and separately configured **self-built tenant apps**, one tenant per app ID. This is not a distributable ISV SaaS implementation. DMs/text only; no group routing or native realtime voice. Audio is an unimplemented adapter seam.

Real use requires public HTTPS, persistent storage, a suitable OAuth identity provider, Feishu app configuration, a ChatGPT plugin connection and MCP Events access. There is no secret/password/cookie-based shortcut to connecting someone else's dot. The repository does not implement an OAuth authorization server.

Read the Chinese-primary [deployment guide](docs/DEPLOYMENT.md), [security boundaries](SECURITY.md), [protocol references](docs/PROTOCOL.md), and [acceptance checklist](docs/ACCEPTANCE.md). Important limitations: one process per SQLite DB; no exactly-once guarantee; events have no history replay; delivery/order in the bridge does not imply dot completion; IdP revocation may take up to the JWT lifetime (max 1h).

Released under the [MIT license](LICENSE). Publishing the source does not imply a deployed service or verified real-account integration. No live credentials are included.

## Optional WebSocket ingress

Set per-app `ingress: "websocket"` to preserve an existing long-connection setup without changing app security settings. Webhook is still the default. WS authenticates the SDK connection; it does not invent an HTTP signature for plaintext event frames. Expected app/tenant and user/DM/text checks still apply, and the HTTP event route is disabled for WS apps.

Feishu distributes events between concurrent connections for the same app. Confirm exclusive ownership before setting `websocketExclusiveConsumer: true`; the example deliberately defaults to false. If another consumer handles events/cards, compose `authenticatedWebSocketMessageHandler` with the existing `im.message.receive_v1` handler in that authenticated dispatcher and preserve all other handlers. Registering the same event key again without composition overwrites its old handler. This exported function does not authenticate arbitrary JSON and must never be exposed as an HTTP endpoint. The in-process duplicate guard cannot detect other hosts. Public MCP HTTPS, OAuth, and live acceptance remain required.

SDK reconnects handle transient disconnects only. A terminal SDK `onError` during startup rejects the aggregate startup, including apps that were previously ready. After startup, terminal failure closes every WS ingress and makes the main process shut down with a nonzero exit status; use an explicit process supervisor/restart policy rather than assuming a terminally failed client will reconnect itself.
