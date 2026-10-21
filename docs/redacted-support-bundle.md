# Redacted support bundles

In Desktop, open **Settings → General → Support bundle → Export support bundle**. The action is present in both settings layouts. The existing export command in the command palette and export actions on error/recovery screens use the same safe exporter.

The archive is saved to Downloads as `bharatcode-support-<UTC timestamp>-<unique ID>.zip`. Desktop attempts to reveal the completed file in the system file manager. Nothing is uploaded. If revealing fails, the archive is still saved. Repeated clicks while an export is running share that operation; another export after completion creates a new file. Writes use a temporary file and rename; the archive receives owner-only permissions on systems that support POSIX permissions.

## Contents

The archive contains exactly one file, `support-bundle.json`, with `formatVersion: 1`:

- Generation time and validated application version.
- OS platform, numeric OS release (vendor/host suffixes removed), CPU architecture, and update channel.
- Cached local Desktop-sidecar auth mode/state and an authenticated flag. This is a snapshot, not a live sign-in check. An uninitialized or unavailable account is unknown. WSL/remote identities are not included.
- Symbolic config-directory, global-config, override-file, and auth-store presence checks. True/false indicate presence/absence; `unavailable` means the check could not be made. Files are not read for these checks.
- Local database availability, SQLite schema version, application migration format/count, a validated numeric migration prefix, snapshot source, and capture time. While Desktop is running, these come from the existing sidecar: it captures the small summary during normal database initialization and sends it in its private ready message. Export reads the in-memory snapshot and performs no SQLite query or connection, so an active WAL does not prevent the metadata from being included. The summary is explicitly labelled `runtime_snapshot`; it describes initialization, not later external schema edits. SQLite schema version and application migration version are distinct. Missing, memory-only, actively journaled, damaged, or inaccessible storage is reported without creating, migrating, or repairing a database. When no valid live snapshot is available (for example, startup failed or the sidecar exited), recovery uses `file_snapshot` metadata: immutable SQLite reads are used only when no nonempty WAL/rollback journal is present; file identity and journal state are checked again after reading. Without a runtime snapshot, active journal writes or a changing database yield unavailable metadata, so the bundle never ignores pending WAL changes or creates/updates SQLite helper files. Unknown values are null or fixed status values.
- Counts of known error categories from the current process. Categories are startup, sidecar, authentication, database, update, network, renderer, and other. Only the most recent 200 recorded categories within 24 hours are retained in memory. Restarting clears them. This is not a complete error history; only instrumented failure paths contribute.

No credential contents, OAuth tokens, API keys, account names/emails, raw prompts/chats, repository links, absolute local paths, exception messages, stack traces, log files, crash dumps, or network captures are included. Automatic export offers no switch to include them. Users can supply any additional context separately in their support request.

The runtime snapshot contains only numeric migration/schema metadata, fixed status/source values, and an ISO capture time. It is projected before sidecar IPC and again in the main process. It is cleared when that exact local sidecar exits or is replaced; late messages from an old owner cannot populate the replacement. Snapshot collection or observer failures do not prevent normal startup. No endpoint or renderer action accepts SQL or requests raw database data.

The metadata collector resolves channel/platform-specific storage paths and supported overrides locally. It does not initialize the agent, query a provider, refresh account status, or read conversation rows. Collection failures yield partial diagnostics. Unknown strings and additional fields are discarded by the final document builder, rather than relying on a token-prefix blacklist.

## Local verification

Run the configured package scripts, which scope Desktop tests to source and apply the app's required Solid/happydom conditions:

```sh
cd packages/desktop
bun run test
bun typecheck

cd ../app
bun x playwright install chromium
bun run test
bun typecheck
```

The app browser suite includes a real Chromium fixture for both Support section styles, saving/error/retry states, disabled progress, and web/unsupported visibility. Chromium is an explicit local test prerequisite; the test never contacts GitHub or a production backend. Controller tests cover duplicate clicks and suppress returned paths/errors.

Desktop tests extract every ZIP member and check synthetic private data is absent; verify trusted IPC, coalescing, write/retry, partial metadata, and reveal failure; and exercise the real read-only Node SQLite collector on fixture databases. The collector tests cover current and legacy journals, missing/malformed/locked storage, memory/overridden database paths, effective sidecar home/channel overrides, empty-current/legacy journal transitions, and platform/channel path resolution. A native Node integration test uses the real initialized database service and actual production exporter with an open WAL database; it checks schema/migration fields in the ZIP, scans for private sentinels, and compares every DB/WAL/SHM byte and directory entry across export. Other closed-WAL and live-WAL fallback fixtures compare directory entries and auxiliary-file bytes as well as the main database.

These are source and local browser checks. They do not establish packaged Electron acceptance, native Windows/macOS verification, publishing, or installation. Any release preparation, packaging, qualification, publishing, or installation must be delegated to `gpt-6-luna` with `max` reasoning.
