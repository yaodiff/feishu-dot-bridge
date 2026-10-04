# Feishu ↔ personal dot bridge

Experimental self-hosted TypeScript MVP connecting each user's Feishu DM to their **existing personal dot** through authenticated MCP Events and a reply tool. Not an official OpenAI/Feishu project; not production-audited or live end-to-end verified.

## Quick start

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

Requires Node.js 24+. The demo and integration fixtures are MOCK ONLY and make no real account/network calls.

Each user authenticates this MCP resource server through an external OAuth2.1 identity provider. A short-lived, one-use pairing code is consumed only by a signed/encrypted Feishu user DM. The server binds OAuth issuer+subject to app+tenant+open_id. Each binding supports one active callback subscription. Text events route to that subscription; replies are restricted to the original stored message owned by that account.

Included: official MCP v2 SDK, protocol 2026-07-28, strict JWT/JWKS checks, encrypted Feishu callbacks, SQLite inbox/outbox, message-id deduplication, bounded retries, Standard Webhooks signing, HTTPS callback verification with DNS pinning/public-IP checks, owner-scoped delivery status, Docker and CI.

Scope: multiple users and separately configured **self-built tenant apps**, one tenant per app ID. This is not a distributable ISV SaaS implementation. DMs/text only; no group routing or native realtime voice. Audio is an unimplemented adapter seam.

Real use requires public HTTPS, persistent storage, a suitable OAuth identity provider, Feishu app configuration, a ChatGPT plugin connection and MCP Events access. There is no secret/password/cookie-based shortcut to connecting someone else's dot. The repository does not implement an OAuth authorization server.

Read the Chinese-primary [deployment guide](docs/DEPLOYMENT.md), [security boundaries](SECURITY.md), [protocol references](docs/PROTOCOL.md), and [acceptance checklist](docs/ACCEPTANCE.md). Important limitations: one process per SQLite DB; no exactly-once guarantee; events have no history replay; delivery/order in the bridge does not imply dot completion; IdP revocation may take up to the JWT lifetime (max 1h).

Released under the [MIT license](LICENSE). Publishing the source does not imply a deployed service or verified real-account integration. No live credentials are included.
