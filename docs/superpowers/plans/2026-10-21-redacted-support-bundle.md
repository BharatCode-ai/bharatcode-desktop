# Redacted Support Bundle Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task in the current session. Steps use checkboxes for tracking. Release preparation, packaging, qualification, publishing, and installation must be delegated to `gpt-6-luna` with `max` reasoning.

**Goal:** Complete [Desktop issue #10](https://github.com/BharatCode-ai/bharatcode-desktop/issues/10): let users export useful support diagnostics without exposing secrets or private work.

**Architecture:** Replace the existing raw-log archive with an archive containing one explicitly constructed diagnostic JSON document. Collect only bounded metadata from Desktop's existing runtime and local storage; add a discoverable action in both General settings layouts. Keep the existing export API so command-palette and recovery-screen exports use the same safe implementation.

**Tech stack:** Electron main/preload, TypeScript, SolidJS, existing typed i18n, existing ZIP library, Node SQLite, Bun tests.

**Spec:** The issue linked above plus the requirements and proposed decisions in this document. Approved by the user; source implementation is tracked below.

## Requirements

| Requirement | Planned output or behavior | Task |
| --- | --- | --- |
| App version | Validated app version; no arbitrary build metadata | 1–2 |
| OS and architecture | Platform enum, bounded OS release, architecture enum | 1–2 |
| Update channel | `dev`, `beta`, or `prod` from Desktop branding | 2 |
| Auth mode/status | Fixed mode and state enums plus authenticated boolean; no account identity | 2 |
| Config path presence | Boolean presence checks under symbolic names; no absolute paths or file contents | 2 |
| Local DB schema/migration version | Read-only SQLite schema version and application migration summary, separately labelled | 2 |
| Recent non-secret error categories | Fixed categories and counts for the current run's last 24 hours | 3 |
| Easy to find | General settings action; retain command palette and recovery actions | 4–5 |
| Redacted by default | Explicit output schema; no raw files appended | 1, 4 |
| Token regression protection | Adversarial fixtures checked against the actual exported archive | 1, 6 |

Always exclude OAuth access/refresh tokens, API keys, credential files, raw prompts, chat contents, private repository URLs, full email addresses, account names, absolute user paths, arbitrary exception messages, stack traces, network captures, and crash dumps. Even user-provided email is excluded from this automatic bundle; users can include it separately in a support request.

## Repository findings

- Source checkout: `/mnt/kingston/bharatcode-desktop-reference`, GitHub default branch `dev`, inspected commit `1e97842919d87a350b38ea5fcf55f952af072e2e`.
- Current working branch: `support-bundle`. No product source edits have been made. Dependencies were installed with the frozen lockfile; tracked files were unchanged before this plan.
- `packages/desktop/src/main/logging.ts::exportDebugLogs()` currently collects raw Desktop logs, server logs, and Crashpad files. Its manifest includes absolute paths. A separate safe action would leave those existing export paths unsafe, so the plan replaces their shared implementation.
- `exportDebugLogs` already crosses main IPC, preload, and the app platform interface. Its consumers include the command palette, error page, and native recovery flow.
- `runtime-accounts.ts` owns account snapshots; snapshots include identity fields that must never be copied wholesale into diagnostics.
- `packages/core/src/storage-paths.ts` owns platform/channel directory resolution. `global.ts`, config flags, and `database/database.ts` add overrides; diagnostics must reflect those without importing modules that initialize storage.
- Application migrations use the `migration` table; older databases can use `__drizzle_migrations`. SQLite's `schema_version` alone is not the application migration version.
- Desktop's existing draft-store tests build a Node-targeted test module and run it under Node because Bun 1.3.14 does not implement `node:sqlite`. Reuse that approach for real database tests.

## Global constraints

- Use the existing Desktop instance and data. Do not start another agent, sign in, refresh credentials, or contact a provider to generate diagnostics.
- Do not restart the running application or server; the app package explicitly prohibits it.
- Keep runtime dependencies within the repository's documented direction. Reuse pure storage-path resolution; do not import Core startup/database services into renderer code.
- No new runtime dependencies. Use the current ZIP library and SQLite runtime.
- Renderer calls go through `window.api`; IPC registration stays in `src/main/ipc.ts`.
- New visible copy uses typed i18n keys. Preserve all existing English strings and keys. New keys use the existing English fallback; do not claim additional translations are complete.
- Run tests and `bun typecheck` from package directories, not the repository root; do not invoke `tsc` directly.
- Keep source implementation/tests, packaged artifact qualification, publishing, installation, and platform verification claims separate.
- Release work is reserved for a `gpt-6-luna` subagent with `max` reasoning. This plan does not authorize publishing a release or installing an app.

## Proposed output and privacy boundary

Keep `exportDebugLogs(): Promise<string>` and return the saved archive path to the local caller. Use a branded filename such as `bharatcode-support-<UTC timestamp>.zip`. Its only member is `support-bundle.json`; no log directories are traversed or copied.

The versioned document contains only:

- `formatVersion: 1`, generation time, validated app version, OS platform/release/architecture, and update channel.
- `auth`: mode `bharatcode_oauth`; state `signed_out`, `signed_in`, `needs_sign_in`, `connection_issue`, or `unknown`; `authenticated` boolean. Report the local Desktop sidecar only. Include `source: cached` so the bundle does not imply a live auth check. Unavailable or uninitialized state becomes `unknown`.
- `config`: symbolic presence flags for the resolved config directory, known global config files, explicit config-file override, and auth-store file. Never serialize those paths or read credential contents. Missing files are normal; inaccessible checks report `unavailable`, distinct from absent.
- `database`: availability `available`, `missing`, `unavailable`, or `memory`; numeric SQLite schema version; migration format `current`, `legacy`, or `unknown`; applied count; validated numeric migration timestamp/prefix or `null`. No database rows, free-form migration names, table listings, or database pathname.
- `errors`: `scope: current_run`, `windowHours: 24`, and counts from a fixed category vocabulary. No messages, filenames, URLs, runtime identifiers, or user-supplied strings.
- Fixed collection-status values for unavailable sections. Failure objects and exception text never enter the document.

Proposed categories: `startup`, `sidecar`, `authentication`, `database`, `update`, `network`, `renderer`, and `other`. Record a category at known main-process failure call sites; do not classify arbitrary log text. Keep at most 200 category/timestamp entries in memory and discard entries older than 24 hours. State this current-run/retention limit in documentation.

The serializer must construct every output field, validate free strings such as version/release, and reject or substitute malformed values. Do not rely on matching a few known secret prefixes after serializing arbitrary objects. Read-only collection failures should still produce a useful partial bundle; export-write failure must surface a localized generic error without leaking a path or underlying exception.

## Review focus

1. Hostile strings in apparently harmless metadata must never pass through to output. Pin in Task 1.
2. Missing, locked, malformed, legacy, and overridden databases must not be created, migrated, or changed. Pin in Task 2.
3. An unavailable local account must not hang export or expose another runtime's identity. Pin in Task 2.
4. Repeated clicks, failed writes, and untrusted IPC senders must not produce overlapping or unauthorized exports. Pin in Tasks 4–5.
5. Existing recovery and command-palette exports must use the safe archive even when the sidecar or UI is failing. Pin in Tasks 4 and 6.

## Bite-sized implementation tasks

### Task 1: Define and test the allowed bundle document

**Files:** create `packages/desktop/src/main/support-bundle.ts` and `support-bundle.test.ts`.

**Interface:** `createSupportBundle(input: SupportBundleInput): SupportBundle`, with an explicit exported input type and JSON-safe output type matching the contract above. Input contains metadata and already-collected summaries, never file contents or arbitrary log objects.

- [x] Write tests for the exact output keys and fixed value sets; pass sentinel tokens, JWT-shaped strings, emails, repository URLs, prompt text, paths, and nested extra fields through malicious input fixtures. Assert that none reaches serialized output. Validate version/OS release, booleans, finite bounded integers, unknown statuses, and ignored unknown fields.
- [x] Run `bun test src/main/support-bundle.test.ts` from `packages/desktop`; confirm the missing contract fails the tests.
- [x] Implement explicit field projection and validation. Keep unknown/unavailable values explicit rather than inventing healthy defaults.
- [x] Repeat the focused tests until green. Commit as `feat(desktop): define safe support bundle format`.

**Done:** A tested document builder whose output cannot grow when an input object gains private fields.

### Task 2: Collect read-only metadata from the correct local runtime

**Files:** create `packages/desktop/src/main/support-metadata.ts` and `support-metadata.test.ts`; modify `runtime-accounts.ts` and `runtime-accounts.test.ts`.

**Interfaces:** `collectSupportMetadata(input: { channel: Channel; platform: NodeJS.Platform; home: string; temp: string; env: NodeJS.ProcessEnv }): Promise<SupportMetadata>`; `runtimeAccounts.getSupportStatus(): SupportAuthSummary` returns only the projected cached local-sidecar state. Types feed Task 1's input.

- [x] Add failing tests for auth snapshot projection, signed-out and uninitialized state, and WSL entries with private identifiers. Assert no network or credential operation is needed.
- [x] Add temporary filesystem and real Node SQLite fixtures for current/legacy journals, missing DB, missing journal, malformed journal, lock/read failure, and `:memory:`. Assert no new files or changed DB bytes for closed fixture DBs and no writes/migration calls for all cases.
- [x] Add path-resolution tests for Windows/macOS/Linux, all three Desktop channels, XDG/app-data overrides, config-directory/file overrides, and absolute/relative `OPENCODE_DB`. Verify only symbolic presence reaches the document.
- [x] Implement pure path resolution using `StoragePaths.resolve` and the actual config/database override rules. Confirm supported global config filenames against current config loading code before adding presence checks.
- [x] Read only fixed schema/migration metadata with immutable SQLite access after journal checks; active journal writes yield unavailable metadata. Validate file identity/journal state after reading; close connections in all paths. Validate migration values before returning numeric summaries; never export an arbitrary journal string.
- [x] Run `bun test src/main/support-metadata.test.ts src/main/runtime-accounts.test.ts` from `packages/desktop`. Commit as `feat(desktop): collect private support metadata`.

**Done:** Accurate local metadata without touching credentials, conversations, storage initialization, or remote runtimes.

### Task 3: Record recent fixed error categories

**Files:** create `packages/desktop/src/main/support-errors.ts` and `support-errors.test.ts`; modify `logging.ts` and explicit failure call sites in `index.ts`, `server.ts`, `account-session.ts`, and `updater.ts` where their existing failure handling owns the category.

**Interface:** `createSupportErrors(now?: () => number)` returns `record(category: SupportErrorCategory): void` and `summary(): SupportErrorSummary`. Share one main-process instance. Category vocabulary and retention are specified above.

- [x] Add failing tests for each allowed category, invalid runtime input, 24-hour expiry, the 200-entry cap, empty startup, and fixed category counts with no original error payload.
- [x] Implement the bounded in-memory journal. Keep existing application logging unchanged; add category recording only where the failure source is known.
- [x] Exercise representative real failure paths and assert category recording does not alter their existing results or expose raw messages.
- [x] Run the focused error-journal and affected lifecycle tests. Commit as `feat(desktop): summarize recent support error categories`.

**Done:** Useful current-run failure summaries that never require parsing or exporting raw logs.

### Task 4: Replace raw archive export and protect its IPC entry

**Files:** modify `logging.ts`, `index.ts`, `ipc.ts`, and `windows.ts`; create `support-export.ts` and `support-export.test.ts`. Use existing preload/platform API unchanged unless typing requires a narrow correction.

**Interface:** `exportSupportBundle(): Promise<string>` orchestrates Tasks 1–3, creates the one-member ZIP, writes it locally, and reveals the completed file. Existing `exportDebugLogs` delegates to this safe exporter, including recovery callers.

- [x] Write failing archive-level tests: ZIP has exactly `support-bundle.json`, contains valid contract output, and contains none of the private sentinel files placed in log/Crashpad/config directories. No file collector is invoked.
- [x] Cover partial metadata failure, sidecar unavailable, concurrent requests sharing one export operation, write failure with no partial archive, and reveal failure after a successful save.
- [x] Protect `export-debug-logs` with the existing owned-renderer/main-frame policy; test rejection before file I/O for an unowned sender or subframe.
- [x] Wire account summaries without auth requests; recovery exports must still work when account/runtime initialization is unavailable. Preserve local logging, crash reporting, and network capture behavior; remove raw archival collection from the export path.
- [x] Save atomically using a unique temporary file and restrictive permissions where supported; clean up on failure. Surface only typed/localized generic errors across IPC, with no raw filesystem exception text.
- [x] Run the focused exporter and IPC tests. Commit as `fix(desktop): export only redacted support diagnostics`.

**Done:** Every existing diagnostic export path produces the same safe archive.

### Task 5: Make the export discoverable in both settings layouts

**Files:** create `packages/app/src/components/settings-support.tsx` and `settings-support.test.tsx`; modify `settings-general.tsx`, `settings-v2/general.tsx`, and `packages/app/src/i18n/en.ts`.

**Interface:** Shared `SettingsSupport` component consumes the existing platform `exportDebugLogs` action and accepts `v2?: boolean` for the two established settings row/button styles.

- [x] Add failing component tests for desktop visibility, absence when unsupported, action invocation, disabled/in-progress state, successful save feedback, generic failure feedback, and retry after failure. Render both settings layouts to prove the action is discoverable there.
- [x] Add new typed keys for “Support bundle”, “Export support bundle”, a short privacy description, progress, saved, and failed states. Preserve existing export-log labels and keys in recovery and the command palette.
- [x] Implement the section in General settings using existing UI primitives, language API, and a single store for operation state. Do not render the returned local pathname or exception message.
- [x] Run focused app tests with its Solid/happydom preload. Commit as `feat(app): add support bundle export to settings`.

**Done:** A visible, accessible, recoverable settings flow in both interfaces.

### Task 6: Verify the complete source change and document the contract

**Files:** add `docs/redacted-support-bundle.md`; finish regression coverage in Tasks 1–5's test files.

- [x] Seed a synthetic fixture environment with OAuth tokens, API keys, credential files, chats, private URLs, names/emails, logs, network captures, and crash files. Export through the actual archive producer, extract every member, and scan names and contents for each sentinel. Assert expected diagnostic fields remain useful.
- [x] Test recovery and command-palette wiring against that producer; check failure and partial-collection paths as well as successful export.
- [x] Run `bun test` and `bun typecheck` from `packages/desktop`.
- [x] Run `bun test` and `bun typecheck` from `packages/app`. Record existing failures separately if encountered; do not describe a partially passing suite as clean.
- [x] Run `git diff --check` and focused lint on changed files using the repository tooling.
- [x] Document the schema, local save/reveal behavior, exclusions, current-run error limit, partial-data meanings, and that generating a bundle never uploads it. Record source verification separately from GUI and packaged-platform results.
- [x] Prepare the final source diff and evidence for review. A requested PR should reference issue #10; do not close the issue solely because a local test passed.

**Done:** Source-level acceptance is demonstrated and the privacy/coverage limits are documented.

### Task 7: Release handoff, only when requested

**Owner:** `gpt-6-luna`, `max` reasoning, as required by project instructions.

- [ ] Hand off the exact reviewed commit, changed files, test evidence, known limitations, and acceptance checklist.
- [ ] Have the release subagent prepare/package/qualify the candidate through the repository's normal release process. No primary-agent packaging or installation.
- [ ] Qualify real settings → export → extract on each claimed platform, including signed-out and failed-sidecar scenarios. Use synthetic private data and independently inspect every archive member.
- [ ] Publish/install only within the user's release authorization. Record artifact identity and platform proof separately from source results.

**Done:** A release claim is backed by artifact and runtime evidence for the platforms actually tested. This task is outside the current planning request.

## Execution order and completion gates

Tasks 1 → 2 → 3 → 4 → 5 → 6 are the source implementation sequence; Task 7 is a separate release handoff. Keep the checklist updated after each task. The primary agent implements the source tasks in this session unless the user requests another execution method.

Issue acceptance is ready for review when all requested metadata is represented, both settings layouts expose the export, all existing export callers use the safe path, archive-level privacy tests pass, and package checks have reported results. A locally implemented change is not yet a published or installed fix.

## Plan self-review

- All seven requested metadata classes map to Tasks 1–3; discoverability maps to Task 5; default privacy and token regression tests map to Tasks 1, 4, and 6.
- The five review-focus risks each have tests assigned to their owning task.
- Existing preload/platform signature is preserved; no public HTTP API or generated client changes are proposed.
- No mobile connection, OpenTunnel, provider, or agent-execution behavior needs modification.
- Source implementation is authorized. No release, installation, PR creation, issue comment, or issue closure is authorized.

## Final local result — 2026-10-21

Source tasks 1–6 are complete. Task 7 was not requested and remains unexecuted. No PR, push, release, or installation was performed.

| Check | Result |
| --- | --- |
| Desktop `bun run test` | 173 passed, 0 failed |
| App `bun run test` — unit | 751 passed, 0 failed |
| App `bun run test` — browser | 56 passed, 0 failed |
| UI `bun run test` | 29 passed, 0 failed |
| Desktop/app/UI `bun typecheck` | All passed |
| New support files, fixture, and fallback `oxlint` | 0 warnings, 0 errors |
| `git diff --check` | Passed |

These results cover configured local source/UI suites, not separate release/candidate packaging scripts or native packaged-platform acceptance.

A fresh read-only review found three collector issues. Regression tests reproduced and verified fixes for WAL/SHM side effects, effective sidecar home/channel overrides, and empty-current/legacy migration transitions. There were no deferred minor findings. Final suite runs above include the fixes.

### Execution decisions and implications

- Used the existing clean `support-bundle` branch in the approved reference checkout; no additional worktree was needed. Mobile source was not modified.
- Recorded updater errors in the controller shared by settings and native callers. Only instrumented failures contribute; the counts do not claim to replace full logs.
- Used the configured `bun run test` scripts. Bare Bun discovery includes separate release/candidate tests and does not apply app test conditions; no release qualification is claimed.
- Used the existing `bharatcode.ts` shared English fallback for new copy. Other-language translations are not claimed complete.
- Added a real Chromium fixture alongside controller tests. Playwright Chromium must be installed for that local browser suite.
- Repaired a pre-existing app parity failure with a shared fallback for four output-limit messages across 61 locale dictionaries. English copy and test expectations were preserved; these messages remain English until reviewed translations are supplied.
- Isolated Electron-boundary fixture compilation in a fresh Bun subprocess after reproducing Bun 1.3.14's cross-build workspace-resolution failure. The same production exporter/collector remains under test.
- Used immutable SQLite reads with journal/file stability checks. A nonempty WAL or rollback journal makes DB metadata unavailable; this avoids auxiliary-file mutation and stale metadata from ignored journal contents. The rest of the bundle still exports.
- Kept existing palette rejection handling and error-page gating. Their safe-export target changed, while pre-existing error-presentation behavior remains.
- Deferred native packaged-platform verification and all release work because this request is local source/tests only; any later release work requires the mandated Luna/max handoff.

## Follow-up: database metadata while Desktop is running

User authorized removing the active-WAL limitation for local running Desktop, with no DB/helper-file modification and no private output. Local-only/no-PR/no-release constraints remain.

- [x] Capture a small schema/migration snapshot from the existing database service during normal server initialization; optional observer failures must not block startup.
- [x] Project and carry it in the existing private sidecar ready message. Bind it to the exact local-sidecar lifetime, clear it on exit/replacement, and ignore old-owner updates.
- [x] Prefer the snapshot during export, with explicit source/capture time. Preserve conservative immutable-file recovery when no runtime snapshot exists.
- [x] Exercise the real Node database service and production exporter while WAL is open; assert metadata in the ZIP, no private sentinel values, and unchanged DB/WAL/SHM bytes and directory contents apart from the ZIP.
- [x] Finish relevant package tests/typechecks and independent review; record results below.

Decision: querying an already-open SQLite connection can still update shared-memory read state. Capturing metadata during ordinary initialization and exporting the resulting in-memory summary makes export itself free of SQLite I/O. Runtime migration/schema metadata is labelled as an initialization snapshot and does not claim to observe arbitrary later external schema edits. No private database copy, checkpoint, second agent/database instance, public HTTP endpoint, or raw SQL interface is introduced.

Follow-up verification (2026-10-21): Desktop 178 passed; server suite 326 passed, 2 pre-existing skips; app unit 751 passed and browser 56 passed; UI 29 passed. Desktop/server/app/UI typechecks passed. New support and snapshot helper files have 0 lint warnings/errors; diff whitespace checks passed. The fresh read-only review found no actionable defects and verified exact database-layer ownership, export's no-SQLite path, boundary projection, and snapshot generation invalidation. No packaging, installation, native platform qualification, push, or PR was performed.

Review scope decisions: packaged/native-platform acceptance remains outside local source verification. The internal observer contract is synchronous and its production consumer is synchronous; promise-returning observers are not part of this hook contract.
