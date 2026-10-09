# Managed-proxy callback transport

Default callback delivery uses `direct-pinned`, which validates approved HTTPS destinations and public DNS addresses in the application. An optional transport supports a specifically configured runtime-owned loopback proxy. It is not a generic proxy client or a way to bypass network policy.

## Explicit selection

```sh
CALLBACK_TRANSPORT=managed-proxy-openai
CALLBACK_HOSTS=connectors.api.openai.com
```

The host list must contain exactly that public callback host. The runtime must provide `CODEX_NETWORK_PROXY_ACTIVE=1` and a credential-free `http://127.0.0.1:<port>` or `http://[::1]:<port>` proxy through `HTTPS_PROXY` or `https_proxy`. Conflicting values, remote proxies and missing configuration fail closed. Do not set the marker merely to make an arbitrary proxy appear trusted.

Proxy environment variables alone do not select this transport. Omission or `CALLBACK_TRANSPORT=direct-pinned` retains the default. The obsolete `managed-proxy-openai-candidate` value is rejected.

## Security and bounds

- Exact `https://connectors.api.openai.com:443`; only validated path/query vary
- Fixed CONNECT authority, TLS SNI and hostname/certificate verification; no redirect, Upgrade, plaintext or direct fallback
- Only the expected signed webhook headers; locally computed content length
- Request body 256 KiB, response body 64 KiB, response headers 16 KiB
- Absolute CONNECT deadline 12 seconds; full operation deadline 15 seconds, including queueing
- Bounded [connection pool](CALLBACK_POOL_CANDIDATE.md), exclusive leases and no internal replay of ambiguous signed POSTs
- Sanitized diagnostics omit callback paths, query strings, headers, secrets and bodies

The proxy owns remote DNS resolution and upstream address policy. This mode does not perform the default application's public-IP pinning. Operators must assess that different trust boundary; a configured marker is not evidence of equivalent protection. A proxy trusted by the runtime may inspect TLS traffic according to the installed trust store. No request or event can select the proxy or another destination.

## Checks

```sh
npm run test:proxy-candidate
npm test
npm run check:cloud-egress
```

The last command is an explicit credential-free HEAD probe to the fixed public callback root. It contacts the network; it neither creates a subscription nor proves account, Tunnel or dot connectivity. A 404 can show the host answered without proving the callback path works.

Local transport tests use synthetic credentials/certificates and loopback CONNECT/TLS fixtures. Real callback latency improvement and long-running reliability require per-installation observation. Network-policy refusal is an operational blocker to resolve with the host administrator, not an invitation to change hostname, TLS validation or route.

Before migration, securely preserve the installation identity, bridge token, storage key and consistent SQLite state. Stop the former consumer before cutover. This transport provides no secret-provisioning service or durable-hosting guarantee.
