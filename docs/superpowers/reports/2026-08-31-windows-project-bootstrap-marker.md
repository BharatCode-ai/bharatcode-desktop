# Windows project bootstrap: native marker and read-only diagnosis

## Scope and identities

- Branch: `codex/windows-recovery-actions`, canonical WSL worktree `apps/desktop/.worktrees/windows-recovery-actions`.
- Native marker correction: `ec1675a5c1aa2710ed1c3d7388895dfaab3d22b5`, parent `5ed620b74e30a39ba4980f63109421bd643a85c4`.
- Read-only diagnosis correction / packaged source: `d3dc1b13d36ac3b61dc3665d5c6eb2771b50b18c`.
- Exact native build tree: `21fda0b5d7ccb51b79cdacc21875ee5580d81e59`, matched against the canonical commit before building.
- Local diagnostic only. No push, publication, release, website re-enable, formal JIT/WSL acceptance, or promotion.

## Observations and root causes

The user confirmed successful browser return and Account signed-in in the normally installed `b7b443` package. Project/session loading returned server errors; the model chooser also showed no eligible models. Real-profile reads were limited to sanitized error classification, marker format/metadata/ACL and read-only SQLite integrity/schema/migration checks. No credential file was read, reset, repaired, or rewritten.

The existing marker was a regular single-link file, correctly LF-terminated, naming `20260630000000_add_goal_mode`. Its native Windows mode was `0666`; owner was the current user and effective grants were current user/SYSTEM. SQLite integrity was `ok`; all 21 migrations and the exact inferred schema matched. The runtime nevertheless classified it `permission-invalid` because it applied POSIX mode `0600` on Windows.

The first correction fixed that error. Packaged testing then found a second restart defect: `openSchemaDatabase` accepted `readonly:true` but opened the RW Drizzle connection. On close, that connection checkpointed WAL: the synthetic main DB changed from 4,096 to 176,128 bytes during diagnosis. The before/after guard then classified its own mutation as corruption. The second correction uses the existing platform SQLite read-only adapter and rejects write-mode requests before opening any file.

## Implementation boundary

Windows marker reads reuse the reviewed native held-file/ancestor ACL, reparse, single-link, and identity checks. POSIX mode/owner and exact schema/integrity checks remain. No mode-check bypass alone, ACL widening, directory-fsync suppression, or live-profile repair was used.

Windows marker publication reuses private held-parent native publication with file flushes before/after activation. Quarantine pins ancestors and the original regular single-link leaf, compares the immediate pre-quarantine bigint file ID against the native held ID, validates ACLs, and performs a same-parent relative no-replace rename with pre/post flush and revalidation. Directory/unsafe markers remain preserved and fail closed. This is not an uninterrupted handle from the original diagnosis, nor hardware power-loss certification.

Failed or unconfirmed publication remains failure even if activation occurred. Tests demonstrate successful native publication followed by a synthetic lost confirmation; a later full schema diagnosis may accept the resulting valid marker. No claim is made that every failed repair leaves the marker absent.

## RED / GREEN evidence

- Installed `b7b443` synthetic project bootstrap: RED HTTP 500.
- Native marker fixture before correction: 2 failures (valid Windows marker rejected; missing-marker publication failed).
- Native marker tests after correction: **10 pass, 45 assertions**. Covers private native mode, malformed/quarantined marker, ACL/link/junction rejection, directory preservation, same-bytes leaf replacement, no-replace collision, helper failure, schema drift, and publication uncertainty.
- Native held-credential regression: **16 pass, 1 compiled opt-in skip, 62 assertions**. No auth behavior widening.
- Linux schema/DB/migration recovery at the first correction: **19 pass, 123 assertions**.
- Direct read-only regression RED: original connection allowed INSERT; rejected write-mode still created a DB.
- Linux schema + DB after second correction: **14 pass, 34 assertions**.
- Exact packaged `ec1675` first process: project/session loading passed; restart RED HTTP 500 with the classified WAL/checkpoint observation above.
- Exact packaged `d3dc1b13`: **1 pass, 7 assertions** — Start Fresh in an isolated normal-parent fixture, actual packaged Node sidecar, two successful session-list requests, process stop, fresh-process restart, two successful session-list requests, unchanged marker bytes.
- Exact `d3dc1b13` packaged recovery CLI: **3 pass, 35 assertions** (valid-source isolation, invalid-selection rejection, Start Fresh/interrupted retry).
- Exact packaged sidecar auth harness: create/read, restart, replacement/read, logout/signed-out **PASS**, synthetic credentials only. The independent compiled read helper is the preserved prior first-use helper; do not describe it as rebuilt from `d3dc1b13`.
- Native Core/OpenCode/Desktop typechecks: **PASS**; OpenCode rerun after the read-only correction also passed.
- Desktop full Linux suite: **213 pass, 1,267 assertions**.
- Native full Desktop suite: **210 pass, 3 fail, 1,263 assertions**. The remaining tests assume POSIX executable modes in Unix/Mach-O/ELF packaging fixtures; those test/implementation paths are unchanged by this correction. An initial additional 12 failures were the native checkout's CRLF conversion of a strict canonical JSON fixture; copying the exact canonical LF bytes removed those 12. No full-native-suite green claim or release waiver.
- Windows build, same-source Linux/WSL runtime build/version smoke, unpacked Windows packaging, NSIS construction: **PASS**. Existing build warnings remain.

## Immutable local diagnostic artifact

Installer: `C:\Users\Shrey Gupta\AppData\Local\Temp\bc-diagnostic-d3dc1b13\bharatcode-desktop-win-x64-d3dc1b13.exe`

- Version: 1.15.22 beta; unsigned (`NotSigned`); preserved read-only.
- Installer bytes: `221038272`; SHA-256: `c2edc5107957ca874930f66b2932e9dd6fadff997dcc3c125066e7b0beb8085d`.
- `app.asar`: `260607770` bytes; SHA-256 `88d4d5e7e4c4cce1451d64938509a2408b296b2b7210dd2c0cc62ae57382908d`.
- Packaged CLI: `144453632` bytes; SHA-256 `ce754c453bfc41075966df8bd3f4898d240d61939b96c594f5e4bfad3f930333`.
- WSL runtime: `129362048` bytes; SHA-256 `0bbf1912582de8d66c2ec89029c07d2fd491ea52f020df410a03142fe3616240`; manifest source is exact `d3dc1b13`.

## Remaining acceptance

The running user installation has not been replaced in this checkpoint. Preserve its signed-in profile; do not uninstall, choose Start Fresh, or rewrite its valid marker. Next is a normal update installation and visible project/session verification in that profile, then independent authenticated model-list verification. The unauthenticated production catalog probe returned 401 as expected and establishes nothing about this account's eligible models. No provider/catalog changes were made.

Formal acceptance infrastructure and promotion HOLD remain. WSL filesystem free space was approximately 147 MiB; no expansion or unrelated cleanup was performed.
