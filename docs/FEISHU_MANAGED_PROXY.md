# Explicit managed-proxy routing for Feishu

The Feishu SDK's API and WebSocket paths can use the deployment's runtime-owned loopback proxy. Image-resource downloads use the same selected route through their own bounded binary transport.

## Selection and trust boundary

```sh
FEISHU_TRANSPORT=managed-proxy
```

Omission or `FEISHU_TRANSPORT=default` retains the SDK's ordinary transport. Ambient `HTTPS_PROXY` or `NODE_USE_ENV_PROXY` does not select this mode. Unknown modes fail before reading app credentials or opening the database.

Selection requires the same validated managed environment/proxy shape as the [callback transport](CLOUD_PROXY_CANDIDATE.md). Callback selection is independent. No event, URL or tool argument can choose a proxy or hostname. `NO_PROXY` cannot bypass this explicitly selected route.

Owned agents perform native HTTP CONNECT and TLS instead of assuming Axios proxy rewriting composes with Node's global proxy agent. This route delegates remote DNS and upstream address policy to the managed proxy; it does not add application-side public-IP pinning. No alternate proxy, IP substitution, certificate exception or direct fallback is provided. Respect policy denials.

## Fixed destinations and limits

- API: exactly `open.feishu.cn:443` or `open.larksuite.com:443`, over HTTPS
- WS: exactly `msg-frontier.feishu.cn:443` or `msg-frontier.larksuite.com:443`, matching the authenticated discovery API domain, over WSS
- Other discovered WS hosts fail closed and report only a sanitized hostname for independent review; never the ticket-bearing URL
- CONNECT uses the original hostname; TLS uses normal CA and hostname verification
- HTTP redirects are rejected; the pinned SDK WS client does not follow redirects
- SDK API request/response bodies: 256 KiB each; CONNECT response headers: 16 KiB
- Absolute CONNECT deadline: 12 seconds; CONNECT plus TLS: 15 seconds
- SDK API request: at most 15 seconds, or the SDK's smaller timeout
- WS handshake: 15 seconds; managed-proxy ingress readiness wait: 35 seconds
- Image download: separate 4 MiB body cap and 15-second overall read budget, as described in [image intake](MEDIA_INPUT_CANDIDATE.md)

Shutdown cancels requests and destroys tracked CONNECT/TLS/WS sockets, including incomplete tunnels and upgraded sockets no longer in Node's normal pool. A process supervisor must still handle terminal runtime exits; it must not start a competing Feishu consumer.

## Verification

```sh
npm test
npm run demo
```

Fixtures exercise local CONNECT/TLS, natural subprocess exit, invalid host/certificate, redirect and size rejection, stalled/trickling phases and cancellation. These checks do not prove account permissions, real event delivery, all regional endpoint compatibility or sustained uptime.

The pinned `@larksuiteoapi/node-sdk` 1.74.0 accepts a custom HTTP instance, WS agent and handshake timeout. Recheck that integration and run contract tests before changing SDK versions. The repository supplies no general-purpose deployment launcher or private credential-input helper.
