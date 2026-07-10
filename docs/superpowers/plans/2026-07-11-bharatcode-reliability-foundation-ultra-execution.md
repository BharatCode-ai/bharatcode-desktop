# GPT-5.6 Ultra Execution Prompt — BharatCode Reliability Foundation

You are the primary implementation agent for the BharatCode Reliability
Foundation. Work continuously toward the complete outcome in the local WSL
workspace. Do not stop after research, an audit, a design proposal, a partial
slice, or a plan. Select the implementation architecture yourself and carry the
approved requirements through implementation and verification unless a genuine
external-contract blocker makes further progress impossible.

## Workspace and repositories

- Platform repository: `/home/ubuntu/bharatcode`
- Shared Desktop/CLI repository: `/home/ubuntu/bharatcode/apps/desktop`
- The Desktop repository is a nested Git repository whose default branch is
  `dev`.
- The parent platform worktree may contain substantial unrelated changes from
  other durable lanes. Preserve all unrelated work in both repositories.
- Recheck branch, worktree, remote, and recent-commit state before acting. Do
  not assume the state recorded when this prompt was written is still current.

## Authoritative requirements

Read this entire file before choosing an implementation:

`/home/ubuntu/bharatcode/apps/desktop/docs/superpowers/specs/2026-07-11-bharatcode-reliability-foundation-requirements.md`

It is the source of truth for product behavior, constraints, migration
guarantees, security, distribution, and acceptance. It contains 85 numbered
requirements and 24 acceptance scenarios.

Do not replace it with a new product design or reopen its resolved decisions.
Do not interpret an implementation convenience as permission to weaken a
requirement. If two requirements appear inconsistent after inspecting current
code, identify the exact conflict and seek direction rather than silently
choosing one.

This prompt intentionally does not prescribe files, classes, functions,
internal APIs, migration algorithms, task ordering, or commit decomposition.
Those decisions belong to you. Choose the implementation that best satisfies
the requirements in the current codebase and remains maintainable against
upstream OpenCode evolution.

## Required product outcome

Deliver one BharatCode coding product with two first-class surfaces:

- BharatCode Desktop as the graphical coding workspace.
- A complete BharatCode CLI/TUI, installed as `bharatcode`, using the same fork
  and runtime as Desktop.

The new CLI must replace the current thin npm wrapper. It must not invoke,
install, resolve, or require an external OpenCode executable. Do not create a
second fork or duplicate the runtime into the platform repository.

Desktop and matching-channel CLI must share account, project, session,
configuration, model, tool, permission, migration, and recovery semantics.

## Product decisions that must not drift

1. The shipped product supports only provider `bharatcode` and approved
   BharatCode models.
2. Generic provider machinery may remain private for maintainability, but no
   other provider, provider plugin, provider configuration, API-key flow, or
   provider UI may remain reachable in shipped Desktop or CLI products.
3. Authentication uses the runtime's native provider-auth contract and native
   `auth.json` under BharatCode-owned channel data identity.
4. Existing users must sign in fresh. Do not import an existing OpenCode auth
   store or `~/.bharatcode/credentials.json`.
5. Never read, modify, or delete `~/.bharatcode/credentials.json` in the new
   runtime. Leave it untouched for users who still have the old wrapper.
6. Preserve the branded Desktop Account experience while making it a client of
   shared native account state.
7. Model calls, sharing, dictation, profile/status lookup, and other
   authenticated services must consume the shared account contract rather than
   read credential files.
8. Preserve supported existing chats, projects, sessions, Goal Mode state,
   share control, and safe user configuration through a one-time migration to
   BharatCode-owned locations.
9. Leave all legacy OpenCode source data untouched as rollback backup. Do not
   maintain ongoing dual-read compatibility after successful migration.
10. `npm install -g bharatcode`, `npm install -g bharatcode@next`, and
    `npx bharatcode` must install/run the complete BharatCode CLI/TUI without a
    separate OpenCode installation.
11. npm package source and publication authority move to the shared
    Desktop/CLI repository through an unambiguous coordinated handoff from the
    platform repository.
12. Operational product identity must be BharatCode: commands, protocol, data,
    config, state, cache, logs, help, errors, diagnostics, updater, environment
    contract, and URLs.
13. Do not invent a BharatCode endpoint. Missing services fail closed and are
    coordinated with their durable owning lane.
14. Do not release, publish, tag, deploy, or update production systems without
    a separate explicit release instruction after all gates pass.

## Reliability outcomes that are part of completion

This is not only an authentication or rebranding task. Completion includes:

- bounded, deduplicated refresh behavior;
- correct revocation, logout, account switching, idle/resume, DNS, offline, and
  service-unavailable behavior;
- safe database upgrade and repair for supported released schemas without
  delete-first support instructions;
- one-time migration that is idempotent, concurrency-safe, recoverable, and
  incapable of activating a partial destination;
- Desktop/CLI cross-surface session and project continuity;
- a redacted Desktop support bundle and equivalent CLI doctor/export behavior;
- content-free local startup, project-ready, and time-to-first-displayed-token
  stage measurements;
- product-policy guards against active OpenCode provider, account, console,
  share, update, schema, documentation, API, or hosted-service fallbacks;
- release-candidate verification for Windows, Windows+WSL, macOS arm64/x64,
  Linux AppImage/`.deb`, and npm CLI use.

## Required working discipline

1. Read every applicable `AGENTS.md` before editing its subtree. Repository
   instructions override generic habits.
2. Inspect the current implementation and current GitHub/release state before
   deciding how to satisfy the requirements.
3. Build an internal requirements-coverage map so no numbered requirement or
   acceptance scenario is lost. Do not ask the user to make implementation
   choices that the approved requirements deliberately assign to you.
4. Preserve unrelated worktree changes. Never use destructive Git or filesystem
   commands to clean another lane's work.
5. Use tests before or alongside behavior changes in proportion to risk. Run
   tests from the package directories required by repository instructions.
6. Use synthetic migration, auth, diagnostic, chat, project, and secret-shaped
   fixtures only. Never inspect, print, or commit real user credentials, chats,
   prompts, private repositories, or support archives.
7. Keep secrets out of logs, commentary, command output, diffs, fixtures,
   screenshots, diagnostics, and final reports.
8. Verify current behavior with executable evidence rather than assuming a
   local comment, historical plan, or prior agent report is still correct.
9. Coordinate missing platform contracts with the actual durable leadership
   lanes. The durable CEO lane is thread
   `019f4d6e-58cd-7d01-a3db-853c14cb4dc2`. Do not substitute disposable
   subagents for durable executive coordination.
10. Continue through integration and verification. Do not hand back isolated
    components that leave the public architecture split.
11. Commit only intentional, scoped changes. Do not push or publish unless the
    user separately authorizes it.

## External-contract blockers

If an approved requirement depends on a BharatCode backend or website contract
that does not exist:

- verify the absence from current code and deployed contract evidence;
- identify the exact request/response, redirect, schema, or release dependency;
- implement the local fail-closed boundary and every independent requirement
  that can still be completed safely;
- coordinate the missing contract with the durable owning lane;
- do not invent a URL, fake a successful flow, restore an OpenCode fallback, or
  mark the overall requirement complete.

A blocker in one contract does not justify stopping unrelated safe work.

## Verification and evidence requirements

Use the approved requirements document as the completion checklist. Before any
completion claim:

- run relevant unit, contract, integration, typecheck, build, packaging,
  migration-fixture, and cross-surface tests;
- verify clean-install and supported-upgrade behavior;
- verify failure, interruption, concurrency, rollback, redaction, and
  unsupported-provider cases;
- verify Desktop and CLI share matching-channel state and sessions;
- verify no new runtime path reads the legacy credential file;
- verify no shipped operational path falls back to OpenCode services;
- distinguish tests actually run from platform checks that remain pending;
- inspect the final diffs and worktree scope in both repositories.

Do not claim cross-platform success from a single local build. Use available CI
or platform evidence where local verification is impossible, but do not publish
release artifacts without explicit authority.

## Required final handoff

Your final handoff must include:

1. Outcome summary in user-facing language.
2. Architecture actually chosen and why it satisfies the requirements.
3. Changed repositories and intentional commits.
4. Migration and rollback behavior delivered.
5. Desktop and CLI user journeys delivered.
6. Authentication, provider-policy, database, diagnostics, and performance
   behavior delivered.
7. Exact verification commands and observed results.
8. Platform/CI evidence and any checks not run.
9. A requirements-to-evidence matrix covering every numbered requirement
   (`ID-*`, `PROV-*`, `AUTH-*`, `MIG-*`, `SHARE-*`, `CLI-*`, `DESK-*`, `DB-*`,
   `DIAG-*`, `PERF-*`, `SEC-*`, `REL-*`, `XR-*`).
10. An acceptance-scenario matrix covering all 24 scenarios.
11. Any genuine remaining external-contract blockers, their durable owners, and
    the safe fail-closed behavior in place.
12. Manual verification instructions for Shrey.
13. Release-readiness assessment without performing a release.

The objective is complete implementation and evidence, not merely a plausible
patch. If a requirement remains unmet, say so explicitly and keep working where
meaningful progress remains possible.
