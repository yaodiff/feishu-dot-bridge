# Contributing

Node 24+ is required. Run `npm ci --ignore-scripts`, `npm test`, and `npm run demo` before submitting changes.

- Keep ownership checks server-side and scoped by OAuth issuer/subject plus Feishu app/tenant/open_id
- Never add a production mock-auth bypass, caller-supplied owner routing, arbitrary reply destinations, or unsigned callback acceptance
- Preserve exact webhook bytes for signing/verification and persistent idempotency
- Add regression tests for any identity, delivery, auth or protocol change
- Use only synthetic fixtures. Never include live credentials, user messages, databases or callbacks in issues/tests
- The MVP is single-process SQLite. Do not add replicas without real transactional leases and cross-process coordination
- Audio, groups, ISV distribution and realtime voice are separate designs requiring new authorization and privacy review
- Use private vulnerability reporting, not public issues, for sensitive security findings

Contributions follow the repository’s MIT license. Keep the experimental status and unverified live-integration limitations explicit. Report security issues through a maintainer-approved private channel; never disclose live data in a public issue.
