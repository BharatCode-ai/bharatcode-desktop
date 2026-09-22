# Upstream catch-up — status

Branch `chore/upstream-catchup-2026-09`, cut from `upstream/dev` @ `fee476bb90`
(anomalyco/opencode, 2026-09-19).

We had not synced since the fork point `6b03be5468` (2026-05-23): upstream was
2,423 commits ahead, we were 298 ahead. This is a re-fork, not a merge — start
from upstream and re-apply our work theme by theme, evaluating each one, rather
than resolving 499 overlapping files at once.

## Where it stands

### Continuation checkpoint — September 22, 2026

The original inventory below is retained as baseline evidence, not a claim that
the re-fork is complete. All continuation work is local on this branch. No
Desktop release, installation, protocol registration, or real-profile migration
has been performed during this continuation.

Completed local themes:

- `6f2d8a7ed9`: CLI account/login/catalog integration, branded distribution
  identity, and fixed safe model-recovery error classification.
- `d658994adb`: legacy session Goal actions, HTTP routing and continuation on
  the new event-sourced session engine; upstream failure handling preserved.
- `5896f9d324`: main account routes and shipped v2 model/catalog adapters;
  protected credentials remain server-side and generic upstream composition is
  preserved for internal tests.
- `0a689461a6`: main-owned Desktop account flow on the upstream multi-window
  shell, safe callback logging, private sidecar credentials, health barrier,
  and development/diagnostic protocol-registration containment.
- `398d49a7e0`: same-checkout CLI/Node packaging, branded update/storage identity,
  explicit unsigned Windows and signed/notarized macOS packaging requirements.
  Building the CLI no longer publishes assets implicitly.
- Renderer account gate/settings integration: explicit sign-in, retryable
  connection failures, revision-aware account updates and generic-provider UI
  isolation. New account copy uses a shared English fallback; existing locale
  values and positional native-menu translations are preserved.

Verification so far: compiled Linux CLI reports 1.15.35; compiled Node runtime
passes isolated signed-out/auth-boundary checks; real Node SQLite draft text and
attachment references survive close/reopen. Renderer App suite passed 734 tests
before the additional native positional-mapping regression; production frontend
build and Desktop typecheck pass. The Bun Desktop suite is **not fully green**:
106 pass, one failure and one error involve Bun 1.3.14's node:sqlite support;
the corresponding real Node draft persistence smoke passes. These are compiled
runtime checks, not installed Electron or cross-platform acceptance.

Remaining, in dependency order:

1. Conversation error/recovery UI and Goal ribbon on the new timeline/composer,
   with production benchmark comparison; audit other retained user features.
2. BharatCode-only WSL runtime provisioning/security, capabilities, dictation,
   and final branding/assets. Do not reinstate the legacy startup recovery gate.
3. Regenerate affected SDKs and reconcile release workflows with exact-source
   artifacts, no implicit publication, and the current platform signing policy.
4. Broad affected suites, production UI/browser checks and native package
   lifecycle verification. Document any baseline failures explicitly before a
   replacement recommendation.

`caeed55c38` records the account renderer checkpoint. Both upstream settings
layouts now expose Account instead of generic provider setup when hosted by
BharatCode Desktop. Conversation error rows now offer explicit connection checks
for the three classified account/catalog failures; checks never replay prompts
or tools. Both legacy and current API loading paths are wired; helper tests cover
missing selected models, incomplete sign-in, safe failures and stale completion.
App unit suite: **740 pass / 0 fail**, 3,069 assertions; App typecheck passes.

After installing the pinned Playwright Chromium shell, the production timeline
benchmark passed before and after the recovery-row change. One trial per scenario
(72 review diffs) is a bounded regression smoke, not a statistical performance
claim. All trials had zero wrong-destination, blank and unknown samples.

| Scenario | Before stable (ms) | After stable (ms) |
|---|---:|---:|
| Review closed, cold | 47.7 | 48.0 |
| Review closed, hot | 29.6 | 28.9 |
| Review open, cold | 70.8 | 69.5 |
| Review open, hot | 61.2 | 54.9 |

Raw local benchmark logs: `/tmp/bc-catchup-timeline-before.log` and
`/tmp/bc-catchup-timeline-after.log`. These run the production-built renderer with
synthetic API fixtures; they do not establish packaged account sign-in or native
WSL behavior. The initial missing-browser attempt is not a performance result.

`1285cb5b17` records the recovery integration. Follow-up Desktop typecheck passes;
the browser-condition component suite passes **41 tests / 0 failures**, 100
assertions. This suite uses happy-dom, not an installed Electron window.

### Next integration boundary: WSL

Initial source inspection found that the inherited multi-distro shell installed
from `opencode.ai/install`, resolved `$HOME/.opencode/bin/opencode`, and launched
the upstream binary. Initial inspection also found broadly bound serving and
sidecar credentials in public state; the security checkpoint below corrects those
two boundaries. None of those runtime paths have been executed during this
continuation. Provisioning remains a release blocker, not an accepted BharatCode
implementation at that checkpoint; the launcher integration below replaces it.

The retained `origin/dev` implementation instead has same-source runtime
manifests/digests, explicit non-root identity checks, a bounded typed stdio
handshake, loopback serving, and main-owned authorization. Reuse those boundaries
while reconciling the new multi-window/server lifecycle; do not blindly copy the
old single-runtime startup flow or bring back its removed recovery gate.
Account ownership must be explicit for the selected runtime: the Windows
account session alone does not authenticate an independent WSL credential store.
Do not copy credentials between profiles or expose them to the renderer to bridge
that gap. SDK generation also needs reconciliation: the renderer currently uses
the pinned vendored v2 promise client, while the local client package exposes a
different generated surface. A successful local client generation alone does not
prove that the renderer consumed the regenerated API.

### WSL authorization checkpoint — September 23, 2026

- Native and WSL sidecar credentials now remain in a main-owned authorization
  registry. Public WSL snapshots/events carry null credential fields, enforced by
  their shared type. Each outstanding request remains bound to its original
  runtime; stop/replacement invalidates that authority without changing another
  runtime's authorization. Cross-runtime/external redirects fail closed.
- WSL IPC actions require an owned renderer's main frame. Subscriptions stop
  forwarding after window ownership is lost. Fixed safe failures replace raw
  thrown payloads at IPC/startup boundaries; arbitrary child stdout/stderr is no
  longer copied to the main log or renderer startup error.
- WSL serving is restricted to loopback. The existing terminal-opening action
  rejects shell metacharacters in distribution names before invoking cmd.exe.
- Focused Desktop security/controller tests: **24 pass / 0 fail**, 86 assertions,
  including the credential-leak regression that failed before the correction.
  Desktop and App typechecks pass; App unit suite remains **740 pass / 0 fail**.

This checkpoint does not add new WSL features or certify runtime installation.
The OpenCode installer/resolver still needs replacement with the same-source
BharatCode artifact and typed lifecycle. No WSL distribution, account store,
installed app, protocol association or user data was changed by execution tests.

### WSL stdio runtime checkpoint — September 23, 2026

The hidden Desktop serve mode now uses the retained bounded JSONL protocol:
source/version/executable digest/non-root identity precedes readiness; credentials
arrive through stdin and bind to that listener only. Two simultaneous listeners
reject each other's credential and anonymous requests without changing process
environment. Normal serve behavior remains available. EOF and Stop tear down
the listener; shutdown failures are fixed safe outcomes, not successful stops.

Build identity is accepted only from the matching clean checkout. Ordinary CLI
builds without that identity cannot act as a verified WSL sidecar. The compiled
acceptance harness uses fresh synthetic homes and checks identity, protected
health/account routes, Stop/EOF and process/port cleanup. The old binary fails
that harness before any identity record; rebuilding this exact checkpoint is
the next check. This does not yet replace Desktop's old WSL installer/resolver.

Source transport/listener checks and OpenCode/Desktop typechecks were run. An
existing plugin-client test intermittently reaches its five-second timeout; its
isolated and subsequent focused runs pass, so no full-suite stability claim is
made here. Native Windows-to-WSL installation and packaged lifecycle remain open.

`f26e216863` records the stdio checkpoint. Focused source checks: **19 pass / 0
fail**, 75 assertions, both typechecks pass. The rebuilt beta Linux CLI at this
exact source passed **2 compiled lifecycle tests**, 30 assertions, covering Stop
and EOF in isolated homes. This is Linux child-process evidence, not a Windows
Electron-to-WSL installed test. An initial build-shell invocation supplied the
wrong repository SHA; the clean-source check correctly rejected it. The retry
used the literal verified worktree SHA and passed.

The following packaging checkpoint restores the closed WSL artifact verifier
and non-overwriting staging operation, without the old installer implementation.
Candidate CLI builds emit a read-only runtime plus source/version/architecture/
length/SHA-256 manifest. Windows packaging stages and rechecks that resource and
requires matching Windows/runtime architecture; other platforms do not bundle
the WSL payload. Tests cover manifest/digest drift, non-files, writable files,
symlinks/hardlinks and preservation of existing staging output. Actual selected-
distro provisioning and Desktop consumption of this artifact are still next.

### WSL launcher integration — September 23, 2026

Desktop now resolves its own bundled, verified Linux runtime instead of invoking
the OpenCode internet installer or executing an arbitrary previously installed
OpenCode binary. The selected distro must resolve a consistent non-root user.
Windows resource translation is round-tripped; installation uses a verified,
content-addressed path under the selected user's branded cache, with no overwrite
of a running/existing artifact. Checks reject writable ancestors, symlinks,
hardlinks, wrong owners, permission drift and changed content; they do not repair
an existing user's permissions. The Linux namespace is trusted against concurrent
same-user replacement, not represented as a held-object security boundary.

Runtime launch uses an empty Linux environment plus a small explicit allowlist,
and receives the short-lived HTTP credential only through typed stdin. Source,
version, channel, executable digest and non-root UID must match before the main
process can expose the runtime. Anonymous health must return 401; authenticated
health must succeed. Stop is bounded, acknowledged and idempotent; failure kills
the child and remains a failure rather than a successful stop. Controllers await
shutdown and revoke request authority first. The obsolete shell-launch and health
polling code has been removed. Internal `opencode` IPC/type names are retained as
compatibility names only; remaining WSL settings copy/prerequisites need cleanup.

Focused Desktop tests: **42 pass / 0 fail**, 143 assertions. Core stdio tests:
**7 pass / 0 fail**, 32 assertions. Both typechecks pass. The compiled smoke now
also drives the real runtime through Desktop's actual transport; it must be rerun
after committing/building this exact new protocol identity. Windows Electron/WSL
acceptance, account ownership for the selected runtime, path-picker translation,
and the rest of the catch-up remain incomplete.

Additional recovery contract received during this work: API verification outages
will use 503 `authentication_unavailable`, expiry 401 `session_expired`, invalid
credentials 401 `invalid_credentials`; model listing becomes public while
inference retains entitlement/restriction enforcement. Reconcile Desktop's
recovery classification against the actual API changes when that theme resumes:
retain tokens on transient failures, refresh once for true expiry, never retry
subscription/bans as auth or replay a partially delivered generation. No API/web
changes or other-task coordination were performed in this Desktop worktree.

`e36f4f269ef14bd66b00bd57e511ee5ab6074a9b` records the launcher integration. The
rebuilt exact beta CLI passes all **3 compiled lifecycle checks**, 33 assertions,
including Desktop's actual transport. A separate native Windows Node 24.14.0
harness then drove the same runtime through `wsl.exe` on Ubuntu-22.04: provision
and re-verification in a fresh `/tmp/bharatcode-wsl-windows-smoke.*` home, identity
handshake, anonymous 401/authenticated health, acknowledged stop, process exit and
closed port all passed. The temporary Linux home was removed. Only a generated
test harness remains in Windows Temp; no app install, protocol registration,
credential copying, real-profile migration, or live account login occurred.

This evidence is deliberately narrower than installed Electron acceptance. The
visible WSL settings flow, selected-runtime account ownership and path picking
still need integration. Native Windows provisioning/transport is no longer an
unexecuted boundary. Local logs: `/tmp/bc-wsl-launch-smoke.log` and the native
`WINDOWS_WSL_PROVISION_TRANSPORT_PASS` result; reproducible Windows harness is
`packages/desktop/scripts/wsl-windows-smoke.ts`.

### Runtime account ownership — September 23, 2026

Desktop now maintains one main-owned account session per verified local runtime.
Each session captures its connection; replacement disposes its pending login,
rejects old replies/callbacks, and preserves monotonic revisions. Callback state
selects exactly one owning runtime rather than trying every credential store.
Unknown runtime IDs do not fall back to the native store. No credentials are
copied between Windows and WSL or exposed to the renderer.

The sign-in gate now sits beneath the selected-server provider. Its account
actions and notifications are scoped to that runtime, with a return-to-local
action if a WSL account cannot be checked. Settings inherit the same scope.
Conversation recovery uses the conversation's actual SDK server, since a tab can
target a runtime other than the globally selected server. API/web behavior and
the newer recovery error contract have not been changed by this checkpoint.

Evidence: Desktop account/callback/routing suites **28 pass**, 114 assertions;
Desktop typecheck passes. Actual Chromium rendering of the gate with synthetic
accounts verifies event isolation, late status replies, runtime-scoped sign-in
and logout, return-to-local and listener disposal. Harness:
`packages/desktop/scripts/runtime-account-browser.ts` (run from `packages/app`).
This is mocked account transport, not live OAuth or installed Electron proof.
Impeccable hardening guidance was used to keep the existing screen and provide a
clear escape/retry without a redesign.

App's configured unit condition (`solid`) passes **740/740**, 3069 assertions;
its separate browser-mode suite passes **41/41**, 100 assertions. Production
frontend build passes. Earlier unconfigured invocations (default Bun server
condition and browser condition applied to the entire unit suite) failed on
Solid export/proxy semantics; they are not the configured suite or a green
result. Logs are under `/tmp/bc-runtime-account-*`. No live profiles, app install,
protocol associations or production services were changed.

### Original re-fork baseline

12 commits. Every one green at the point it landed: `bun turbo typecheck --force`
19/19, and the suites for whatever that commit touched.

|                          |                                                   |
| ------------------------ | ------------------------------------------------- |
| net vs `upstream/dev`    | 1,721 files, +12,786, −503,734                    |
| our tests passing        | 196 (auth, bharatcode, migration, provider, goal) |
| `packages/core`          | 1,100 pass / 0 fail                               |
| upstream provider suite  | 713 pass / 5 fail — **identical to baseline**     |
| upstream session + agent | 462 pass / 0 fail — identical to baseline         |

The 5 provider failures are pre-existing and auth-dependent (they want real
bearer tokens); I confirmed them against a stashed baseline before and after.

## Done

1. **Package prune** — keep 20 workspace packages, drop 11. Re-derived as the
   dependency closure of what we ship over upstream's *current* graph rather
   than replaying the old list.
2. **Root prune** — the whole SST surface, `github/`, `sdks/vscode`,
   `artifacts/`, `perf/`, and the nix packaging.
3. **Branding / DISTRIBUTION** — `distribution.mjs`, the `bharatcode` bin shim,
   `build.ts`, package identity.
4. **Channel-scoped storage paths** — `StoragePaths`, and one data directory
   named for the product.
5. **Auth** — the transactional credential store, SQLite lock, Windows store.
6. **bharatcode-core** — account, catalog, model eligibility, OAuth loopback.
7. **Import engine** — replayed, and taken **off the startup path**.
8. **Provider layer** — the BharatCode catalog, product policy, and the DeepSeek
   reasoning fix from #57.
9. **Goal Mode backend** — schema, migration, state machine, tools, command.

## What is left

Ordered by dependency, not by size.

| Theme | Scope (our delta since the fork) | Notes |
|---|---|---|
| **cli-core** | `src/cli` 28 files +1,035; `src/session` 13 files +877; `src/server` 28 files +581 | `prompt.ts` is the hard one: 220 ours over a 667-line upstream rewrite. Unblocks the Goal Mode HTTP handler. |
| **desktop-shell** | 338 files, +27,680 | The single largest body of work, but only ~12% contested. |
| **app-ui** | `packages/app` 86 files +4,112; `packages/ui` 81 files +324 | Includes re-homing the Goal Mode ribbon. |
| **ci-release** | `.github` 48 files, +8,471 | Re-author from the current workflows, not commit by commit. |
| **tests** | 75 files, +12,448 | Prune while replaying. |
| **sdk + lockfile** | generated | Regenerate last, after Goal Mode and bharatcode-core are in. |

### Known follow-ups

- **Goal Mode is not wired end-to-end.** The API accepts a goal payload but
  nothing routes it. Needs the `ensureGoal*` methods in `prompt.ts` (cli-core)
  and the HTTP handler. The ribbon needs `packages/app` and a regenerated SDK.
- **The Goal Mode ribbon still needs re-homing** onto upstream's
  `session-composer-region-controller.ts`. Doing it before `packages/app` is
  reconciled means doing it twice.
- **One test is skipped with a reason** — `provider-policy.test.ts` scans httpapi
  v2 handler sources that are not on the branch yet.
- **`toV2Provider` has a semantic gap.** The old provider carried
  `enabled: { via: "account" }`; the new `ProviderV2.Info` has no equivalent and
  upstream gates on `request.body.apiKey` or an integration. Decide with the v2
  handlers.
- **`lean-migration-recovery.test.ts`**, when replayed, should resolve paths
  through `StoragePaths.resolve` rather than re-introducing its own
  `canonicalLayout()`, which now duplicates it.
- The two shell/review-pane UI bugs are **dropped, not ported** — upstream
  already fixed both, better than the one-line tweaks we had planned.

## Things worth knowing before continuing

### "0% overlap" never meant "replays clean"

The inventory ranked themes by file overlap. That ranking was wrong twice, and
both times the code compiled or typechecked before failing:

- **bharatcode-core** (0% overlap) did not build. It needs our `auth`, which
  needs `Global.auth`, which needs `StoragePaths` — a theme the plan had placed
  two steps *later*. The dependency graph, not the overlap percentage, decides
  the order.
- **Goal Mode** (0% overlap) built fine and silently did nothing. Sessions are
  event-sourced now: `Session.patch` publishes `SessionV1.Event.Updated` and a
  projector in `core` writes the row. A new session field has to exist in the
  schema the *event* carries and be mapped by the projector, or it is dropped on
  write. Sessions created, `setGoal` reported success, every read came back
  `undefined`.

### Typecheck is not verification

Three separate times a green `turbo typecheck` hid a broken suite:

- stale `AppFileSystem` imports in test files and worker fixtures — five tests
  hung on 15-second readiness barriers because a spawned fixture was missing.
- the product policy defaulting to shipped — **189 upstream tests** failed
  (103 provider, 86 session/agent) while typecheck stayed green.
- `global.test.ts` asserting the tmp directory was literally `"opencode"`,
  missed because I ran only the storage-paths test rather than the core suite.

**Run the affected suites after every theme, including upstream's own**, and
take a baseline before a change that could plausibly break them.

### Prefer the mechanism that removes churn

The product policy first resolved to the shipped layer, on the reasoning that
the restrictive default is the safe one. It is — but it made every generic
composition wrong by default, and fixing it meant threading a policy layer
through ten test files and redoing that at each future sync. Deriving it from
`InstallationChannel` instead gives the same guarantee with no churn: a packaged
beta/prod build is shipped, a local or test build is internal, and a packaged
build cannot forget to opt in.

### Use upstream's tooling, not our replayed copy of it

The Goal Mode column went in through `bun run migration --name add_goal_mode`,
which produced the migration module, the registry, the generated schema and the
snapshot. Our fork's hand-written `packages/opencode/migration/*.sql` is not
replayed — upstream moved that lineage into programmatic modules. Same for
`serviceUse`, which moved into `core` and gained a memo cache: we dropped our
copy rather than replaying it.

## Upstream API drift

The same changes recur in every theme:

| Was (fork point) | Is now |
|---|---|
| `AppFileSystem` (`core/filesystem`) | `FSUtil` (`core/fs-util`) — old export **gone** |
| `Schema.Defect` | `Schema.Defect()` |
| `Schema.Class` for `ProviderV2.Info` / `ModelV2.Info` | `Schema.Struct` — `new X({...})` → `X.make({...})` |
| `export const layer` / `defaultLayer` | `export const node = LayerNode.make(...)`; compile with `LayerNode.compile(node)` |
| `core/util/log`, `Log.Default.warn` | `Effect.logWarning(msg, {...})` |
| `@/effect/service-use` | `@opencode-ai/core/effect/service-use` |
| `@/provider/schema` (`ProviderID`, `ModelID`) | `ProviderV2.ID`, `ModelV2.ID` |
| `MessageV2.WithParts` / `TextPart` / `Assistant` / `User` | `SessionV1.*` from `core/v1/session` |

`FSUtil` exposes only `node` — there is no `FSUtil.defaultLayer`. Tests that
provided `AppFileSystem.defaultLayer` need `LayerNode.compile(FSUtil.node)`.

## Environment

Fetching `upstream` fails under git protocol v2 with
`curl 56 ... bad record mac`. It is the negotiation, not the packfile. Pinned in
`.git/config`:

```
git config --local protocol.version 0
```

Even then `git fetch upstream --prune` (all refs) fails; fetch a single branch:
`git fetch upstream dev --no-tags`. Without `--filter` that also pulls blobs,
which makes the checkout instant despite the `blob:none` partial clone.

**Do not probe with `--depth=1`** — it writes `.git/shallow` and silently
shallow-ifies the repo. Recover by deleting that file; all objects are local.

## PR 47

Closed and stray: it targeted `fix/startup-migration-gate`, which was later
deleted, so it was closed with its work apparently stranded. Both its commits
are non-ancestors of `dev`, but the resulting files are **byte-identical to
`dev`** — the work was re-landed by another route. Nothing is lost; only the
orphan branch `fix/test-macos-paths` remains.
