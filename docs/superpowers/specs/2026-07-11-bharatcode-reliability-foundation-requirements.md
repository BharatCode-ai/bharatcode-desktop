# BharatCode Reliability Foundation Requirements

| Metadata               | Value                                |
| ---------------------- | ------------------------------------ |
| Date                   | 2026-07-11                           |
| Status                 | Approved for GPT-5.6 Ultra execution |
| Primary repository     | `BharatCode-ai/bharatcode-desktop`   |
| Coordinated repository | `BharatCode-ai/bharatcode`           |
| Owning lane            | Product Head — Desktop               |

## 1. Purpose

This document defines the required outcome for the BharatCode Reliability
Foundation. It intentionally specifies product behavior, compatibility,
security, reliability, distribution, and acceptance requirements rather than
an implementation design.

The executing model is responsible for inspecting the repositories, selecting
appropriate abstractions, identifying exact files, designing internal APIs,
sequencing changes, and implementing the requirements. It must not reopen the
resolved product decisions in this document or substitute easier legacy
fallbacks for them.

## 2. Product Objective

BharatCode Desktop and the BharatCode CLI must become two first-class surfaces
of one BharatCode coding product:

- Desktop provides the graphical coding workspace.
- CLI provides the complete terminal UI and coding workflows.
- Both use the same BharatCode-owned OpenCode fork and runtime.
- Both share account, project, session, configuration, model, tool, permission,
  and migration semantics when running on the same release channel.
- The shipped product supports only BharatCode models and services.

The CLI must no longer be a thin wrapper around a separately installed upstream
OpenCode CLI. A second fork or independently evolving CLI runtime is forbidden.

## 3. Resolved Product Decisions

| Question                             | Decision                                          |
| ------------------------------------ | ------------------------------------------------- |
| First portfolio tranche              | Reliability Foundation                            |
| Existing credential transition       | Require fresh sign-in                             |
| Canonical credential store           | Native runtime `auth.json`                        |
| Desktop account experience           | Branded BharatCode Account surface                |
| Other model providers                | Remove from the shipped product                   |
| Generic provider framework           | May remain internal for maintainability           |
| Legacy `.bharatcode` credential file | Ignore and leave untouched                        |
| CLI scope                            | Complete first-class CLI/TUI replacement          |
| CLI and Desktop runtime              | One shared fork/runtime in `bharatcode-desktop`   |
| Second fork                          | Not allowed                                       |
| Existing chats and projects          | Preserve through one-time migration               |
| Legacy OpenCode data                 | Leave untouched as rollback backup                |
| Delivery model                       | Layered development, coordinated complete cutover |
| npm installation                     | Remains a primary CLI installation path           |
| Editor integration                   | Separate later program                            |

## 4. Scope

The Reliability Foundation includes these outcome areas:

1. Unified BharatCode runtime identity.
2. Native BharatCode-only provider authentication.
3. Branded Desktop account management.
4. Complete BharatCode CLI/TUI distribution.
5. Shared Desktop and CLI session/configuration semantics.
6. One-time preservation of existing chats, projects, and safe settings.
7. OAuth refresh, revocation, logout, switching, idle/resume, and connectivity
   reliability.
8. Local database migration and repair safety.
9. Redacted support diagnostics.
10. Local time-to-first-token and startup performance measurement.
11. Coordinated Desktop, npm, website, and release-channel cutover.

## 5. Out of Scope

The following are not requirements for this program:

- VS Code or other editor extensions.
- OS keychain, Credential Manager, or Secret Service integration.
- Other model providers, including as advanced options.
- New Goal Mode, agent, collaboration, sharing, dictation, or marketplace
  features unrelated to the reliability cutover.
- Deep renaming of private workspace packages that have no user-facing or
  isolation impact.
- Automatic upload of logs, diagnostics, prompts, code, or performance data.
- Deletion of legacy OpenCode data or legacy BharatCode credential files.
- Creation of BharatCode equivalents for OpenCode-hosted services that do not
  already have approved BharatCode contracts.
- Stable-channel general availability; the completed foundation may first ship
  on the existing beta channel.

## 6. Runtime and Product Identity Requirements

### ID-1 — One runtime

Desktop and CLI shall use the same runtime source from the existing
`bharatcode-desktop` fork. The delivered CLI shall not invoke, install, resolve,
or require an external OpenCode executable.

### ID-2 — BharatCode public identity

All operational product surfaces shall use BharatCode identity, including:

- executable and command names;
- npm package and installation guidance;
- application and protocol identity;
- data, state, cache, log, and configuration identity;
- configuration filenames and project customization directories;
- help, errors, status, diagnostics, and updater copy;
- local server display identity;
- public environment-variable contract;
- service, schema, documentation, account, share, and update URLs.

The executable and npm package shall be `bharatcode`, the native protocol shall
be `bharatcode://`, logical local product identity shall be `bharatcode`, and
the supported public environment-variable contract shall use the
`BHARATCODE_*` prefix.

OpenCode attribution may remain in licenses and About information. It shall not
appear as active product identity.

### ID-3 — Public command identity

The public executable shall be `bharatcode`. Normal usage shall include:

```text
bharatcode
bharatcode .
bharatcode run <request>
bharatcode auth login
bharatcode auth status
bharatcode auth logout
bharatcode doctor
```

All retained CLI commands shall use BharatCode naming and shall not direct users
to OpenCode services or configuration.

### ID-4 — Configuration identity

New global configuration shall use the platform-standard configuration
directory for logical product identity `bharatcode`. Project configuration
shall use `bharatcode.jsonc` or `bharatcode.json`, and project customization
shall use `.bharatcode/`. The new product shall not emit or require OpenCode
configuration paths or an OpenCode-hosted schema URL.

If a BharatCode schema endpoint is not deployed and verified by release time,
the product shall omit the schema URL rather than use an OpenCode or fabricated
replacement.

### ID-5 — Channel isolation and parity

Desktop and CLI artifacts for the same channel shall resolve the same logical
account, session, project, and configuration stores. Development/test artifacts
shall not read or modify public beta or production user data.

Channel behavior shall cover at least Desktop `dev`, `beta`, and `prod`, plus
npm `next` and `latest` release use.

### ID-6 — Internal maintainability boundary

Private generic provider machinery and private upstream package identifiers may
remain when they reduce fork maintenance and are not exposed operationally.
Their presence shall not make another provider or OpenCode-hosted service
reachable from a shipped BharatCode product.

## 7. BharatCode-Only Provider Requirements

### PROV-1 — Single shipped provider

The shipped Desktop and CLI products shall expose only provider `bharatcode`.

### PROV-2 — Single model catalog

Users shall see and select only models approved for BharatCode. Other providers
or models shall not appear through normal UI, advanced UI, CLI, configuration,
autoloading, plugins, or fallback behavior.

### PROV-3 — Configuration enforcement

Configuration that attempts to activate another provider shall fail closed
with a clear BharatCode-only explanation. It shall not silently load, retain,
or contact that provider.

### PROV-4 — Provider surface removal

Generic provider connection UI, generic provider login/API-key commands, and
other-provider setup guidance shall not ship.

### PROV-5 — OpenCode-hosted feature removal

OpenCode account, console, provider, share, GitHub-agent, update, and hosted
service integrations shall be removed or disabled unless an approved,
functional BharatCode-owned equivalent already exists.

No feature shall fall back to an OpenCode URL.

## 8. Authentication Requirements

### AUTH-1 — Native provider authentication

BharatCode authentication shall use the runtime's native provider-auth contract
under provider ID `bharatcode`.

### AUTH-2 — Canonical credential storage

The canonical credential record shall live in native `auth.json` within the
appropriate BharatCode channel data namespace. Credential storage shall be
owner-readable only.

### AUTH-3 — Fresh sign-in

Existing users shall be required to sign in again after the cutover. The new
runtime shall not import or read credentials from
`~/.bharatcode/credentials.json` or an existing OpenCode auth store.

### AUTH-4 — Legacy credential preservation

The product shall not modify or delete `~/.bharatcode/credentials.json`. The
file may remain for users who have not yet upgraded the legacy npm wrapper.

### AUTH-5 — Branded account experience

Desktop shall retain a branded BharatCode Account surface supporting:

- sign in;
- authorization waiting state;
- copyable browser URL fallback;
- signed-in status;
- refresh/reconnect;
- use another account;
- logout;
- connection-problem status;
- sign-in-required status;
- access to redacted diagnostics.

Users shall not be routed through generic provider setup for BharatCode.

### AUTH-6 — CLI account experience

CLI shall expose equivalent login, status, logout, reconnect guidance, and
failure semantics using the same account state as matching-channel Desktop.

### AUTH-7 — OAuth safety

Authorization shall use approved BharatCode OAuth contracts and shall protect
against callback mismatch, replay, cross-account confusion, and indefinitely
pending flows. A failed account switch shall not replace a valid current
account.

### AUTH-8 — Refresh behavior

The product shall:

- refresh an expiring access token before use;
- refresh and retry at most once after an authenticated request receives 401;
- deduplicate concurrent refresh attempts;
- stop using a known stale token;
- transition to sign-in required when refresh is invalid or revoked;
- retain valid credentials during DNS, timeout, offline, or temporary service
  failures;
- avoid unbounded auth retries.

### AUTH-9 — Idle and resume

After sleep, idle, resume, or network restoration, Desktop and CLI shall
re-evaluate account usability without forcing browser login when refresh remains
valid.

### AUTH-10 — Shared token consumption

Model requests, sharing, dictation, profile/status lookup, and any other
authenticated BharatCode service shall obtain access through the shared account
contract. Those consumers shall not read credential files directly.

### AUTH-11 — Secret containment

Access, refresh, ID, callback, API, and share secrets shall not appear in
renderer state, normal UI, logs, errors, analytics, timing events, support
bundles, or command output.

## 9. Existing Data Preservation Requirements

### MIG-1 — Data to preserve

Supported existing installations shall preserve recoverable:

- chats, messages, and session history;
- projects and workspace history;
- session metadata required for safe continuation;
- Goal Mode state and terminal outcomes where represented in session data;
- records needed to manage existing BharatCode shares;
- safe user preferences, themes, keybindings, permissions, MCP settings,
  capabilities, and agents that remain valid in a BharatCode-only product.

### MIG-2 — Credential exclusion

No provider credential, API key, OAuth access/refresh/ID token, callback token,
or auth record shall migrate. Fresh sign-in is mandatory.

### MIG-3 — Provider/configuration sanitation

Other-provider settings, provider plugins, API keys, OpenCode-hosted service
configuration, unsupported fields, caches, temporary files, and old logs shall
not enter the new BharatCode namespace.

Safe provider-independent configuration may migrate only when it remains valid
under BharatCode product policy.

### MIG-4 — Source preservation

Migration shall not modify or delete any source OpenCode database,
configuration, or data directory. Source data shall remain available as
rollback backup.

### MIG-5 — One-time behavior

Migration shall occur at most once for a destination namespace. After a
successful cutover, the product shall read and write only BharatCode-owned
locations and shall not maintain dual-read compatibility.

### MIG-6 — Integrity guarantee

The destination shall not become active unless migrated data and schema pass
required validity and integrity checks. A failed or interrupted migration shall
not expose a partially migrated destination.

### MIG-7 — Retry and recovery

Migration failures shall be recoverable without deleting old chats. Desktop and
CLI shall provide consistent retry, safe diagnostics, and an explicit
user-chosen start-fresh path.

Starting fresh shall not delete migration sources.

### MIG-8 — Concurrency

Simultaneous Desktop and CLI startup shall not duplicate, race, corrupt, or
partially activate migration. Users shall receive a clear in-progress or
recoverable state.

### MIG-9 — Idempotency

Repeating startup or recovery after a completed migration shall not duplicate
sessions, projects, messages, settings, or shares.

### MIG-10 — Multiple legacy locations

The migration behavior shall account for all supported data locations used by
released BharatCode Desktop builds and supported existing OpenCode runtime use
on Windows, macOS, Linux, and WSL. If more than one eligible source exists, no
source may silently overwrite another or cause silent data loss.

### MIG-11 — Safe user explanation

The upgrade experience and release notes shall explain that:

- sign-in is required again;
- chats and projects are being preserved;
- old data remains untouched;
- other providers and their configuration are not carried forward;
- recovery and diagnostics are available if migration fails.

### MIG-12 — Historical provider metadata

Existing session history shall not be discarded solely because it records a
provider or model that is no longer supported. Historical metadata may remain
for faithful display, but it shall not re-enable another provider. Continuing
such a session shall use an approved BharatCode model or present a clear
BharatCode-only recovery action.

### MIG-13 — Existing share control

The minimum sensitive record required to continue managing or revoking an
existing BharatCode share may migrate with its session. It shall remain
protected as sensitive application data and shall never appear in UI,
diagnostics, logs, analytics, or performance records.

## 10. Shared Desktop and CLI Workflow Requirements

### SHARE-1 — Session continuity

A session created or continued in CLI shall be visible and safely continuable in
matching-channel Desktop, and vice versa.

### SHARE-2 — Project continuity

Desktop and CLI shall identify the same project/workspace consistently and
shall not create duplicate project identity solely because the surface differs.

### SHARE-3 — Semantic parity

Messages, tools, permissions, agent behavior, Goal Mode state, compaction,
sharing, MCPs, and model selection shall have compatible semantics across
surfaces.

### SHARE-4 — Concurrent use

Normal concurrent or near-concurrent Desktop and CLI use shall not corrupt the
local database or produce invalid session history.

### SHARE-5 — Channel boundary

Session continuity is required for matching-channel products. Development/test
instances must remain isolated from public user data.

## 11. Full CLI/TUI Requirements

### CLI-1 — Complete terminal product

The `bharatcode` package shall provide the complete supported TUI and terminal
coding workflows from the shared fork, not merely authentication and launch
wrapping.

### CLI-2 — Core workflows

The delivered CLI shall support the BharatCode-safe equivalents of:

- interactive project coding;
- non-interactive runs;
- session listing, continuation, import, and export;
- account management;
- supported server/attach workflows;
- MCP and agent management;
- BharatCode model inspection/selection;
- statistics and diagnostics;
- supported local project and Git workflows that do not depend on an OpenCode
  hosted service.

### CLI-3 — Command disposition

Every inherited CLI command shall be deliberately retained, adapted, removed,
or deferred. Commands tied to another provider or unavailable OpenCode-hosted
service shall not remain reachable with stale branding or URLs.

### CLI-4 — Wrapper command continuity

Existing wrapper users shall receive coherent behavior for:

- `bharatcode .`;
- `bharatcode auth login|status|logout`;
- `bharatcode doctor`.

`bharatcode opencode configure` shall explain that configuration is no longer
required and shall not write OpenCode configuration.

Unsupported wrapper-only arguments shall fail with precise migration guidance.

### CLI-5 — npm installation

These installation paths shall work on supported platforms:

```text
npm install -g bharatcode@latest
npm install -g bharatcode@next
npx bharatcode
```

The installed command shall run the full BharatCode CLI/TUI without a separate
OpenCode installation.

### CLI-6 — Package ownership

The source and release ownership for npm package `bharatcode` shall move to the
shared Desktop/CLI repository. The platform repository shall stop publishing
the legacy wrapper before the new package source takes ownership. There shall be
no overlapping or ambiguous publisher workflow.

### CLI-7 — Upgrade and rollback

CLI upgrades shall preserve supported BharatCode data and account semantics.
Release-candidate and public packages shall have a defined rollback path that
does not delete user data.

## 12. Desktop Requirements

### DESK-1 — Account integration

The branded Account UI, startup gate, status popover, command entries, and
titlebar account affordance shall all reflect the shared native account state.

### DESK-2 — Platform boundary

Electron-specific code may own native browser opening, deep-link delivery,
window lifecycle, and secure IPC. It shall not own a second credential or token
refresh system.

### DESK-3 — Renderer secrecy

Tokens and credential records shall not cross into the renderer. Renderer code
shall receive only safe account status and allowed actions.

### DESK-4 — Provider UI removal

Generic provider selection, connection, API-key, and other-provider management
shall not appear in the shipped Desktop product.

### DESK-5 — Authenticated features

Model calls, sharing, and dictation shall continue working after the cutover and
shall use the shared native account contract.

### DESK-6 — User-facing paths

Normal Account and onboarding UI shall not instruct users to inspect or manage
credential/config files. Safe diagnostic paths may be exposed only where they
are actionable and contain no secrets.

## 13. Local Database Reliability Requirements

### DB-1 — Upgrade safety

The product shall preserve chats and projects when upgrading from every local
database schema shipped in supported public Desktop releases.

### DB-2 — Repair

Known missing-column, index, migration-version, and interrupted-migration
conditions shall have safe repair or recovery behavior where repair is
possible.

### DB-3 — Backup

User data shall remain recoverable if a schema upgrade or repair fails.

### DB-4 — Integrity

The product shall detect and clearly report database integrity failures rather
than continuing into misleading or destructive behavior.

### DB-5 — No delete-first support

Deleting app data shall not be the primary troubleshooting or recovery path.

## 14. Diagnostics Requirements

### DIAG-1 — Shared diagnostics

Desktop shall provide an easy-to-find support bundle, and CLI shall provide
equivalent information through `bharatcode doctor` and an explicit export
command.

### DIAG-2 — Included metadata

Diagnostics may include:

- product version, release channel, OS, architecture, and installation method;
- safe account-state category;
- expected file presence and permission status without file contents;
- database schema, migration, repair, and integrity status;
- updater/package state;
- MCP, LSP, provider, and service health categories;
- recent categorized and redacted errors;
- startup, project-open, and request timing stages.

### DIAG-3 — Excluded content

Diagnostics shall exclude by default:

- every credential, key, token, callback value, or share secret;
- auth or credential file contents;
- prompts, responses, reasoning, messages, code, diffs, commands, and tool
  arguments;
- environment values;
- full email addresses, phone numbers, raw user identifiers, and private
  repository URLs;
- private filenames or paths beyond bounded safe product paths.

### DIAG-4 — Local-first behavior

Generating diagnostics shall not upload them automatically. Any future upload
flow requires separate approval and explicit user action.

### DIAG-5 — Redaction assurance

Representative secret-shaped and private-content inputs from every diagnostic
source shall be proven absent from generated output.

## 15. Performance Measurement Requirements

### PERF-1 — Time-to-first-token stages

Desktop and CLI shall locally measure enough content-free timing stages to
distinguish delay between:

1. user submit;
2. request preparation;
3. network start;
4. first response byte;
5. first parsed model token/chunk;
6. first token displayed to the user;
7. completion or cancellation.

### PERF-2 — Startup stages

The product shall locally measure application/CLI startup and project-ready
time.

### PERF-3 — Privacy

Performance records shall contain timings and safe categories only, with no
prompt, response, token, code, command, tool, or repository content.

### PERF-4 — Diagnostic availability

Timing data shall be available through local diagnostics so support can
separate UI, runtime, network, queue, and model-side delays.

## 16. Error and Recovery Requirements

Desktop and CLI shall distinguish and act consistently on at least these
conditions:

- signed out;
- authorization pending, rejected, expired, or mismatched;
- refresh revoked or invalid;
- temporary DNS/network failure;
- service unavailable;
- unsupported or disabled service;
- credential-store failure;
- migration in progress;
- unsupported migration source/schema;
- migration preflight or integrity failure;
- database repair required or failed;
- BharatCode-only policy violation;
- updater/package incompatibility.

Errors shall provide a concise user action where recovery is possible. Errors
and exit output shall not contain secrets or private content. CLI failure states
shall use stable non-zero exit behavior and machine-readable output where the
command supports automation.

## 17. Security and Privacy Requirements

### SEC-1 — Least exposure

Only the shared account service and provider runtime may handle raw credentials.
Surfaces and feature consumers shall receive the minimum data required.

### SEC-2 — File permissions

Credential and sensitive state files shall use restrictive permissions
appropriate to each supported OS.

### SEC-3 — OAuth isolation

Authorization flows shall prevent state/callback confusion, replay, and one
surface accidentally completing another account's flow.

### SEC-4 — Network fail-closed policy

Unavailable BharatCode contracts shall fail closed. The product shall not use
OpenCode or another provider as fallback.

### SEC-5 — Share safety preservation

Existing BharatCode sharing shall remain manual, BharatCode-hosted, revocable,
and free of OpenCode URL fallback.

### SEC-6 — Synthetic verification data

Testing and migration fixtures shall use synthetic data only. Real user chats,
credentials, prompts, private repositories, or support archives shall not be
used or printed.

## 18. Distribution and Release Requirements

### REL-1 — Complete cutover

No public release shall expose a split state where Desktop uses native auth and
the public full CLI uses legacy credential semantics, or where surfaces use
incompatible session/configuration namespaces.

### REL-2 — Release candidates

Before public cutover, matching Desktop and npm release-candidate artifacts
shall be available for clean-install and upgrade verification.

### REL-3 — Supported platforms

Release candidates shall be verified on:

- Windows Desktop and npm CLI;
- Windows with WSL project use;
- macOS arm64 and x64 Desktop plus npm CLI;
- Linux AppImage and `.deb` plus npm CLI.

### REL-4 — Upgrade scenarios

Verification shall cover clean install, current public beta upgrade, existing
chat migration, interrupted migration, corrupt/unsupported source data,
concurrent Desktop/CLI startup, expired auth after idle/resume, and rollback.

### REL-5 — Website alignment

Public setup and download guidance shall describe the full BharatCode CLI,
fresh sign-in requirement, preserved chats, supported platforms, and current
release artifacts. It shall not instruct users to install or configure
OpenCode.

### REL-6 — npm channel alignment

npm `next` shall be used for release-candidate testing. npm `latest` publication
shall occur only as part of the coordinated public cutover after ownership and
artifact verification succeed.

### REL-7 — Rollback safety

Rollback shall not delete the new BharatCode namespace or untouched legacy
sources. Sessions created after cutover may be temporarily unavailable to an
older binary but shall remain preserved for a corrected release.

### REL-8 — Release authority

Planning and implementation do not authorize npm publication, tags, releases,
installer publication, website deployment, or production changes. Those require
an explicit release instruction after all gates pass.

## 19. Cross-Repository Requirements

### XR-1 — Source ownership

The shared runtime, Desktop, full CLI/TUI, native provider auth, migration,
diagnostics, performance instrumentation, and future npm package source belong
in `bharatcode-desktop`.

### XR-2 — Platform ownership

The platform repository retains website, OAuth/service contracts, model proxy,
sharing, dictation backend, account APIs, and any BharatCode-hosted schema.

### XR-3 — npm handoff

The existing wrapper publisher and the new full-CLI publisher shall coordinate
an unambiguous transfer of npm package ownership and release automation.

### XR-4 — Backend dependencies

If the existing OAuth or service contracts cannot satisfy these requirements,
the executing lane shall identify the precise missing contract and coordinate
with the durable platform/CTO lane. It shall not invent endpoints or preserve a
legacy workaround silently.

## 20. Acceptance Scenarios

The program is not complete until all scenarios below pass with synthetic test
data and appropriate platform smoke evidence.

1. A new user runs `npm install -g bharatcode` and receives the full TUI without
   installing OpenCode.
2. A new Desktop user signs in through the branded BharatCode Account flow and
   can complete a model request.
3. CLI sign-in appears as signed-in state in matching-channel Desktop.
4. Desktop logout appears as signed-out state in CLI.
5. An expired token after sleep refreshes once and the next request succeeds.
6. A revoked refresh token produces one clear sign-in-required state without a
   retry loop.
7. A DNS outage preserves valid account state and produces a connection action,
   not forced logout.
8. “Use another account” changes account only after the new authorization
   succeeds.
9. A current beta user upgrades, signs in again, and retains chats, projects,
   session history, and supported settings.
10. Legacy credential files and source data remain untouched after upgrade.
11. An interrupted or failed migration leaves no partial active destination and
    succeeds safely when retried.
12. Concurrent Desktop and CLI first launch performs one safe migration outcome.
13. A CLI-created session can be opened and continued in Desktop.
14. A Desktop-created session can be opened and continued in CLI.
15. Only BharatCode models and account/provider actions are visible.
16. Other-provider configuration fails closed without network access.
17. Share and dictation work without reading legacy credential files.
18. A supported old database fixture upgrades or repairs without losing chats.
19. A support bundle and `bharatcode doctor` output contain useful safe metadata
    and none of the seeded secrets/private content.
20. Diagnostics distinguish request preparation, network, first byte, parsing,
    and first display timing.
21. Shipped help, UI, configuration, errors, and runtime paths contain no active
    OpenCode operational URL or product instruction.
22. Windows, macOS, Linux, and WSL release-candidate checks pass.
23. npm package ownership and release automation have one authoritative source.
24. Rollback preserves both legacy and newly created user data.

## 21. Current-State Evidence for the Executing Model

The following current facts were verified during requirements discovery and
must be rechecked before implementation because the repositories may change:

- `packages/core/src/global.ts` currently uses logical app identity `opencode`.
- `packages/opencode/package.json` currently exposes binary `opencode`.
- The workspace root currently identifies itself as `bharatcode-opencode`.
- Native auth already exists in `packages/opencode/src/auth/`.
- Provider OAuth orchestration already exists in
  `packages/opencode/src/provider/auth.ts`.
- Desktop OAuth and legacy credential handling currently live under
  `packages/desktop/src/main/bharatcode-auth.ts`.
- The bundled BharatCode provider currently reads
  `~/.bharatcode/credentials.json`.
- Share and dictation currently have direct legacy-token dependencies.
- Desktop already has a branded Account surface and browser URL fallback.
- Current release automation covers Windows, signed/notarized macOS, Linux, and
  Homebrew.
- The platform repository currently owns the npm `bharatcode` wrapper package.
- The live Desktop GitHub backlog includes auth idle/resume, safe SQLite repair,
  time-to-first-token measurement, redacted support bundles, onboarding, release
  documentation, and contributor documentation.

This evidence is context, not an instruction to preserve current structure.

## 22. Execution Brief for GPT-5.6 Ultra

Ultra shall treat this document as the source of product requirements and
resolved constraints. It shall:

- read all repository-local instructions and inspect current code before making
  changes;
- determine the best implementation architecture and decomposition;
- preserve unrelated worktree changes;
- implement the complete requirements across the owning repositories;
- use proportionate tests and cross-platform verification;
- keep all migration fixtures synthetic;
- fail closed when a required BharatCode service contract is missing;
- coordinate missing platform contracts through durable leadership lanes;
- report deviations from these requirements rather than silently changing
  product scope;
- stop before external publication or release unless separately authorized;
- provide a final requirements-to-evidence matrix showing how every numbered
  requirement and acceptance scenario was satisfied or why it remains blocked.

Ultra is explicitly expected to choose the implementation details. This
document does not prescribe file layout, class/function design, migration
algorithm, commit decomposition, or internal sequencing beyond the externally
observable requirements and approved product boundaries.
