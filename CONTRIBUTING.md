# Contributing

Node 24+ is required. The aggregate test suite runs on Linux and requires `/usr/bin/prlimit` (util-linux), `openssl`, and `mkfifo` (coreutils); all transport fixtures use synthetic loopback services. Run `npm ci --ignore-scripts`, `npm test`, and `npm run demo` before submitting changes.

- Personal default is one host, one app, one fixed installation owner. Keep backend authentication, loopback enforcement and verified Feishu app/tenant/open_id binding
- The Tunnel+UI None+Events combination is an explicit live acceptance gate; never turn a failed integration into an unauthenticated endpoint
- Never add a production mock-auth bypass, caller-supplied owner routing, arbitrary reply destinations, or unsigned callback acceptance
- Preserve exact webhook bytes for signing/verification and persistent idempotency
- Add regression tests for any identity, delivery, auth or protocol change
- Use only synthetic fixtures. Never include live credentials, user messages, databases or callbacks in issues/tests
- The MVP is single-process SQLite. Do not add replicas without real transactional leases and cross-process coordination
- Audio, groups, ISV distribution and realtime voice are separate designs requiring new authorization and privacy review
- Use private vulnerability reporting, not public issues, for sensitive security findings

Contributions follow the repository’s MIT license. Keep the experimental status and unverified live-integration limitations explicit. Report security issues through a maintainer-approved private channel; never disclose live data in a public issue.
