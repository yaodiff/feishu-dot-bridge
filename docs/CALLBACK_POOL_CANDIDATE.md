# Callback connection reuse

The explicitly selected [managed callback transport](CLOUD_PROXY_CANDIDATE.md) reuses bounded CONNECT/TLS tunnels. The direct-pinned transport and Feishu transports do not use this pool. Pooling changes connection lifecycle, not callback signatures, authorization, payloads, retries, tools or database schema.

## Ownership and limits

- At most two tunnels and 32 waiting operations per transport instance; overflow fails before sending
- One operation exclusively leases each tunnel; no request pipelining
- Each tunnel is fixed to `connectors.api.openai.com:443` and its configured runtime-owned loopback proxy
- One HTTPS Agent and one authenticated TLS socket per tunnel; the connector cannot automatically reconnect or replay an ambiguous POST
- Reuse only after the entire bounded response and Agent free-socket bookkeeping complete
- Idle expiry: 30 seconds; retirement after 100 requests; peer close/error immediately evicts its tunnel
- A 15-second absolute operation budget begins before queue acquisition and covers queueing, CONNECT, TLS, request and response
- CONNECT has its own 12-second absolute deadline; trickling traffic extends neither deadline
- Queued cancellation removes that waiter; active cancellation destroys only its leased tunnel
- Idempotent `close()` rejects waiters, aborts active/connecting work and destroys owned resources; normal runtime shutdown waits for current bridge work before closing the transport

## Security and ambiguous outcomes

Exact HTTPS destination validation, strict TLS/CA/SNI checks, HTTP/1.1, signed-header allowlists, byte limits and redirect/Upgrade rejection still apply. Each request constructs fresh headers/body; pool diagnostics expose no callback contents.

A peer may close between the health check and write. The operation fails without internal replay. The caller's existing durable retry and idempotency rules decide what happens next; connection reuse does not prove successful processing or exactly-once delivery.

## Verification

Run `npm test` and `npm run demo`. Tests use real loopback CONNECT/TLS exchanges and synthetic secrets, including delayed, stalled and trickling phases, cancellation, socket cleanup and reuse. Synthetic reductions in connection count are not real-world latency measurements. Validate actual proxy keep-alive behavior and end-to-end callback timing before claiming performance gains.
