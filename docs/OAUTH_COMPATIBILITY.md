# Optional OAuth compatibility

Use this path only for an existing deployment that explicitly selects `AUTH_MODE=oauth`. Personal installations should follow [deployment](DEPLOYMENT.md) and do not need an external identity provider. Do not mix personal bridge-token variables with OAuth configuration.

## Identity and access

The runtime verifies JWT access tokens using a fixed administrator-configured HTTPS issuer/JWKS endpoint. It requires RS256 or ES256, the exact issuer and `PUBLIC_URL + /mcp` audience, `sub`, `iat`, `exp`, a string scope containing `bridge:use`, and a token lifetime no longer than one hour. ID tokens, opaque tokens and caller-selected JWKS locations are not substitutes.

The owner is derived from issuer and subject. Subscriptions cannot outlive the token's expiry; renewal requires valid credentials. Offline JWT validation cannot immediately observe upstream revocation, so the remaining token lifetime is a revocation-delay boundary. Immediate local revocation requires an authorized, stopped-service [maintenance operation](OFFLINE_MAINTENANCE.md).

Use an established authorization server supporting the client flow required by the consuming product, such as authorization code with PKCE. Register the exact redirect URI shown by that product. This bridge does not implement signup/login pages, code exchange, dynamic client registration or an identity service. Test discovery, audience, scope, refresh and revocation with the selected provider.

## Feishu configuration

OAuth mode accepts the application array in `examples/feishu-apps.json` or `examples/feishu-apps.websocket.json`. Each app ID is unique and bound to one verified tenant. It does not implement automatic multi-tenant ISV installation/token exchange.

- WebSocket: keep the existing authenticated SDK channel and required private-message permissions; confirm the unique consumer before setting `websocketExclusiveConsumer=true`
- Webhook: configure both encryption and verification secrets, preserve raw request bytes, and expose the verified `/feishu/events/<appId>` endpoint to Feishu over HTTPS
- WS applications' HTTP event paths return 404; arbitrary JSON cannot be treated as authenticated SDK input
- When reusing an existing consumer, compose the original message handler with `authenticatedWebSocketMessageHandler` and preserve other event/card handlers; registering the same event again replaces it

Only WebSocket ingress avoids the public Feishu event callback requirement. That says nothing about API permissions, OAuth browser endpoints, or how MCP is reached. A direct public MCP deployment needs an appropriate reachable HTTPS endpoint. A Tunnel can keep MCP private, but does not automatically make an otherwise unreachable OAuth authorization server usable. Consult the [official Tunnel OAuth guidance](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#oauth) and verify the complete flow.

## Configure and run

Copy `examples/oauth.env.example` to private `.env.oauth` and create the private app configuration. Provision a unique 32-byte base64 storage key securely on the host. Store actual secrets in an approved secret manager or owner-only files, never source control, public logs or chat. Directly changing the storage key makes existing encrypted callback keys unreadable.

Required settings include:

- `AUTH_MODE=oauth`
- `PUBLIC_URL`: HTTPS origin without a path
- `OAUTH_ISSUER`: exact token issuer; `OAUTH_JWKS_URL`: administrator-verified HTTPS JWKS URL
- `FEISHU_APPS_FILE`: private array configuration
- `DATABASE_PATH`: this deployment's private SQLite database
- `STORAGE_KEY` or `STORAGE_KEY_FILE`, and each configured Feishu secret
- `CALLBACK_HOSTS`: exact independently verified callback hosts, never a wildcard
- `ALLOWED_HOSTS`: exact proxy-visible Host values; `ALLOWED_ORIGINS`: explicit browser origins

The full test suite requires Linux, `/usr/bin/prlimit`, `openssl` and `mkfifo`; see [contributing](../CONTRIBUTING.md).

```sh
npm ci --ignore-scripts
npm test
node --env-file=.env.oauth dist/src/main.js
```

The included `compose.yaml` is an OAuth-only template with a single non-root service, loopback host-port publication, a private persistent data volume and read-only app config. It is not a personal-Tunnel container recipe. Container build and deployment require target-host validation; no successful Docker deployment is asserted here.

## Reverse proxy and operations

For a direct HTTPS deployment, forward `/mcp`, `/.well-known/oauth-protected-resource/mcp` and any configured webhook paths. Preserve raw webhook bodies and required Authorization, MCP and Feishu signing headers. Keep the backend private and configure rate/body/time/concurrency limits at the gateway. The application's basic rate limit does not replace per-account gateway protection or trusted proxy configuration.

Do not log Authorization, message bodies, pairing commands, resource keys or full callback URLs. Outbound access is needed for Feishu APIs/WS as applicable, verified callbacks and JWKS. Use explicit proxy modes only within their documented trust boundaries.

Run one process per database and one consumer per Feishu app. Verify `/healthz` separately from actual event ingress, callbacks and end-to-end delivery. Complete [acceptance](ACCEPTANCE.md), private backups and [maintenance](OFFLINE_MAINTENANCE.md) before relying on the service. Personal-mode short text observations do not establish OAuth-mode end-to-end compatibility or unattended reliability.
