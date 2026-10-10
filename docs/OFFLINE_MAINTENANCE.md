# Offline maintenance: eligible inbox-history cleanup

**This maintenance command is Linux-only and requires `/proc/self/fd`.** There is no fallback on macOS, Windows or hosts without descriptor inspection. This restriction applies to maintenance, not to the bridge runtime.

This command is administrator-only and offline-only. Stop **every** process that can open or send from this database first, including supervisors that could restart them. A successful SQLite write lock does not prove that a live worker has no remote request in flight. Make a consistent, private backup under your backup policy before an authorized write. Testing or publishing this code does not authorize operating on a user's database.

## Explicit target and preview

Build the reviewed source. Set `DATABASE_PATH` explicitly to the intended existing database, without symlinks. The target and existing `-wal`, `-shm`, `-journal` sidecars must be ordinary files owned by the effective user, mode `0600`, with exactly one hard link. The immediate parent must be owned by that user with mode `0700`; every ancestor must be a real directory owned by that user or root and not group/other-writable, except root-owned sticky shared ancestors such as `/tmp`. Unsafe permissions are rejected, never silently changed. There is no fallback path based on `AUTH_MODE` and no new database creation. Do not paste credentials or user content into a command.

```sh
# Read-only validation and proposed row counts. Still requires stopped workers.
DATABASE_PATH=/absolute/path/to/existing.sqlite node dist/scripts/maintenance.js purge --dry-run

# Separately authorized cleanup of that database.
DATABASE_PATH=/absolute/path/to/existing.sqlite node dist/scripts/maintenance.js purge
```

Only exact known schema 1/2/3/4 definitions are accepted. Unexpected versions, tables, indexes or triggers; broken foreign keys; invalid row types, states or timestamps; and eligible inbox rows missing their original receipt reservation are refused. Equivalent but manually changed schemas can also be refused; do not bypass validation. The command validates read-only first and revalidates inside one write transaction. It never constructs Store, migrates a schema, changes sending to pending, imports history or contacts a network service. `--dry-run` applies no SQL data/schema writes; normal SQLite read locking and journal-sidecar behavior still apply. It is a preview, not a guarantee against later external changes.

## File-boundary trust model

Run this as its own synchronous, single-process maintenance command. The host, root and other processes running as the same UID must be trusted. Stop bridge workers, backup/rotation tools and any other process that could change this database, its pathname, permissions or parent directories. Do not embed the helper in a multithreaded process or a host with unrelated concurrent descriptor activity.

The command snapshots Linux file descriptors immediately around each SQLite open. It requires exactly one newly opened regular-file descriptor and verifies its actual device/inode, owner, mode and link count against the authorized target. FD-number reuse is distinguished by device/inode; a pre-existing descriptor cannot stand in for the newly opened main file, and ambiguous discovery is refused. This catches the tested pathname-to-symlink swap even when the original pathname is restored before post-open checks. Main-file descriptor identity, pathname, ancestor identities and sidecar permissions are rechecked before write steps and before commit. A detected change during the transaction causes rollback of earlier SQL mutations.

These are fail-closed guards for the stated trusted, quiescent host model, **not an atomic-path or hostile-same-UID/root TOCTOU guarantee**. SQLite still manages journals by pathname. A process with the same UID/root could race between check points, manipulate descriptors or modify memory; the command does not make that host safe. No row data is queried from an inode that fails the opened-file check, but SQLite can read file-header bytes while opening it. Ordinary SQLite read-sidecar/locking behavior remains possible during a preview. Do not work around a refusal by using the old maintenance command or moving a live database.

## What `purge` means

The cutoff is the invocation time minus 30 days, with a strict less-than comparison against the inbox's parseable message timestamp. This is **message age**, not 30 days after delivery, and not an erasure deadline. No schedule is installed.

- Remove an old inbox row only when it has no related job outside `sent`, `dead`, `cancelled`, or `blocked`. An old row with no jobs is eligible too
- Remove its `content_dispositions` first (schema 2/3/4), then its jobs and inbox body. `pending`, `sending` and `uncertain` work, their inbox content and associated omission metadata remain unchanged regardless of age
- Keep **all receipts** indefinitely as minimal source-ID deduplication reservations. Before an inbox row is removed, verify its deterministic event ID and original receipt exist. A replay of that Feishu message ID stays a duplicate, even with altered text/timestamp
- Remove expired pairing codes; remove subscriptions expired more than 30 days ago only if no retained job references them; remove inactive bindings only if no retained inbox, subscription or mirror references them
- Keep revocation markers and active bindings. Do not reroute old jobs or reactivate anything
- Keep **every mirror row unchanged**, including all terminal and uncertain states, body, source ID, source role, identity snapshot, timestamps, attempts and remote message ID. The same source ID and exact body still returns the original reservation; a changed body/role is still rejected

A successful event is `eligible_inbox_history_cleanup_complete`, with counts per affected table and explicit receipt/mirror-retention flags. `--dry-run` reports `eligible_inbox_history_cleanup_preview`. Both avoid logging identifiers, bodies or secret-bearing URLs. A database failure rolls back the entire write transaction; there is no post-commit vacuum/checkpoint step that could ambiguously fail after a successful cleanup.

## What remains unresolved

There is **no automatic expiration of mirror bodies**, and receipt/source reservations are not discarded. Schema 2 uses the original mirror body for its exact-body immutable reservation contract and has no terminal-completion timestamp or separate body-free tombstone. Clearing the body would break the exact-repeat contract; deleting the row could allow a second send after the remote deduplication window. A future minimized-body/tombstone design needs its own policy, runtime/schema changes, tests and review.

This command does not provide full 30-day retention, secure physical erasure, user-requested privacy deletion, deletion of remote copies, deletion of backups. Deleted SQL rows can leave filesystem/journal remnants; no secure-delete/vacuum promise is made. Retained bodies and identifiers still require private access controls, encrypted storage/backups, capacity monitoring and a separately reviewed deletion workflow. Do not disable foreign keys, edit reservations or lower the schema version to force cleanup.

## Revocation is not deletion

```sh
DATABASE_PATH=/absolute/path/to/existing.sqlite node dist/scripts/maintenance.js revoke <principal-sha256> --dry-run
DATABASE_PATH=/absolute/path/to/existing.sqlite node dist/scripts/maintenance.js revoke <principal-sha256>
```

Use the administrator's exact existing principal mapping, never a request-supplied owner. Revocation retains the existing semantics: add a revocation marker, deactivate that owner's bindings/subscriptions, remove their pairing codes, and cancel their pending mirrors on schema 2/3/4. It does not remove messages, recover or resend jobs, or recall an already transmitted request. Sending/uncertain mirror jobs and native job states stay unchanged. `revoke --dry-run` validates the operation, target and database; it does not claim the hash matches a known owner. Repeated revocation is idempotent. Access recovery after revocation is outside this command's scope.

## Verification

The focused maintenance suite uses only fresh synthetic temporary databases and mock senders. It covers schema 1/2/3/4; omission-row FK ordering; inactive bindings with mirror references; protected pending/sending/uncertain work; unchanged mirror bodies/metadata; matching dry-run counts; atomic rollback injection; deterministic source/event reservations and no resend after 40 days; repeated invocations; invalid paths and invocations; unsupported/malformed databases; concurrent write-lock refusal; Linux-only refusal; nonprivate/foreign-owned/hard-linked targets and sidecars; unsafe parents; actual-open inode swaps; FD-number reuse and ambiguity; and detected mid-transaction replacement rollback. Foreign-ownership tests simulate stat metadata without privileged ownership changes. Existing runtime, routing, authentication and mirror tests must also pass before integration. No live maintenance invocation is part of validation.

Schema 4 also retains unresolved awaiting/processing/waiting handling decisions and anchors referenced by retained covered events. Eligible ledger rows cascade with eligible inbox deletion. See [event handling](EVENT_HANDLING.md).
