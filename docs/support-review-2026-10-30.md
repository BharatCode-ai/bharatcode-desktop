# Support bundle reconciliation — 2026-10-30

Addresses Shrey's feedback on Desktop #59 against #67 head `d1034e3f38d30287874230bc099f517d37e8068d`, with current dev `f8c7feacae8a8cf89d9b9cb05a780e306f845d7d` merged locally.

## One exporter

Keep #59's existing canonical `export-debug-logs` route and final allowlisted `support-bundle.json` builder. Settings, command palette, and recovery actions already share it. No additional IPC route, redactor, raw-log collector, or sanitized-config collector is added.

The latest #67 fixes JSON Token authorization, JSON content, private repository URL patterns, authorization object keys, legacy IPC sender checking, and OPENCODE_DB selection. It also adds a metadata document, but continues including redacted raw logs, config, and other archive entries. Importing that whole exporter would weaken #59's narrower output boundary and duplicate the implementation.

## Preserved contributions

Adversarial cases in `packages/desktop/src/main/test-fixtures/support-privacy.ts` are adapted from #67/#68 by **Siva Rama Krishna Reddy Padala (@Krish6115)** and **@prashilthul**, including the latest #67 additions. The fixture credits both contributors. Tests now inject those values into potential metadata fields and neighboring raw logs/config, create a symlink to private material, open every generated ZIP, and check that only the safe document is present, secrets and private paths are absent, useful diagnostics remain, and POSIX permissions are 0600. The output tests exercise the existing exporter; they do not recreate a blacklist implementation.

A separate production-registration test invokes `registerIpcHandlers`, retaining the actual support IPC guard while stubbing Electron and unrelated native services. It proves foreign renderers/subframes cannot export and the owned main frame invokes the canonical exporter. There is no second `export-support-bundle` route to reconcile.

## Validation

| Check | Result |
| --- | --- |
| Desktop source suite | 202 passed |
| Adversarial archive cases | Passed, including JSON auth/content/repo links, secret-key objects, symlink exclusion and 0600 ZIP permissions |
| Production IPC registration | Passed |
| Real initialized runtime / active-WAL export | Passed; DB/WAL/SHM bytes unchanged, only ZIP added |
| OPENCODE_DB absolute/relative/memory and fallback metadata | Passed |
| Both Settings layouts in Chromium | Passed within 56-test browser suite |
| App unit suite | 750 passed; 1 baseline Arabic UI parity failure |
| Server suite | 326 passed; 2 existing skips |
| UI source suite | 29 passed |
| Desktop/server/app/UI typechecks | Passed |

The current dev baseline reproduces the same four missing Arabic `ui.message.outputLimit*` keys. No UI locale change or parity suppression is included.

A fresh independent source review found no actionable issue in the reconciliation tests. Tests use local fixtures, including stubs at Electron boundaries. Packaged/native export acceptance, Windows/macOS runtime behavior, and physical devices are not established. No external PR update, reply, push, package, deployment, or installation was performed.
