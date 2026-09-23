# Upstream catch-up — status

Branch `chore/upstream-catchup-2026-09`, cut from `upstream/dev` @ `fee476bb90`
(anomalyco/opencode, 2026-09-19).

We had not synced since the fork point `6b03be5468` (2026-05-23): upstream was
2,423 commits ahead, we were 298 ahead. This is a re-fork, not a merge — start
from upstream and re-apply our work theme by theme, evaluating each one, rather
than resolving 499 overlapping files at once.

## Where it stands

### Candidate release workflow reconciliation — September 23, 2026

The inherited release workflow still targeted the upstream repository, referenced
the removed CLI package, required Azure signing, and invoked version/tag/npm and
asset-overwrite publication scripts. It is replaced by a manual-only,
contents-read candidate workflow: the selected workflow SHA must equal the exact
checkout SHA, committed CLI/Desktop versions must match, and the checkout must
remain clean. No version rewriting or publication is performed.

The four producers cover five required packages: unsigned Windows x64 NSIS,
Developer-ID-signed/notarized macOS arm64 and x64 ZIPs, and unsigned Linux x64
AppImage/deb. Windows receives a same-source Linux WSL runtime, restores transport
read-only attributes, then uses the existing strict manifest/hash verifier.
macOS verification extracts the final ZIP and checks Developer ID certificate
class, strict signature, stapled ticket, and bundle version. It does not claim
independent team-ownership verification. No DMG is required by this cohort.

Producer receipts and aggregation bind source/tree/version/channel/run/attempt,
package SHA-256/size and signing policy. Missing producers, stale attempts, path
traversal, altered bytes, malformed or cross-artifact updater metadata fail
closed. Raw updater metadata stays separate per architecture; automatic
publication/promotion and final cross-architecture updater merging are not part
of this candidate workflow. Receipts explicitly say **package-build-only** and
**acceptance pending**.

Removed the now-unreferenced version-mutating prepare script, bundle copier,
old publication/version orchestrators and asset-clobbering updater finalizers,
plus the nonexistent native-addon build/resource reference. The manual
`script/release` helper now accepts an explicit remote ref, exact SHA and channel
and dispatches candidate construction only.

Evidence so far: missing-helper RED; **16/16 focused candidate/packaging/WSL
tests, 80 assertions**; Desktop typecheck and a separate direct typecheck of the
new build helpers pass. No hosted job, Windows/macOS signature check, installer,
protocol registration, real account or publication has been executed. Exact
native package contents, installed lifecycle, other inherited CI workflows and
the final completion audit remain open.

The first clean exact-source local build passed compiled CLI version smoke and
Node server bundling, then exposed Electron-Vite's temporary timestamped config
module as untracked during config evaluation. The generated
`electron.vite.config.[0-9]*.mjs` file is now ignored narrowly; the source config
and all other checkout changes remain subject to the original clean-SHA guard.
This failure was not a reason to disable source identity validation.

Local exact-source build at `cd81b4bc1c2263741919b6e6a043871f57c24878`
then passed compiled CLI version smoke, Node bundling, Electron main/preload/
renderer and Linux AppImage/deb packaging. Actual builder output uses
`linux-x86_64.AppImage` and `linux-amd64.deb`; the candidate verifier was corrected
from the assumed x64 filenames with a two-failure RED and **17/17 focused GREEN,
84 assertions**. Direct helper typecheck passes. Updater verification checks
both the files array and legacy primary path/digest, and staged copies are
rehashed before receipt creation.

Read-only Debian extraction verified embedded package version 1.15.35, the exact
source string in compiled main, and identical bundled CLI/app.asar bytes against
the builder output. Artifact SHA-256:

- AppImage: `daae8eea8e9835c1e58ec2c90ed318e976d91d5109d67f0ab4179c171ca86cd9`.
- Debian: `f183f91bda196a481a38ee06086c9d8ca63721b5e63fad68a4586d82d93165ed`.
- Bundled CLI: `fff5b4a42ecdf39a446833c6e26acd5f0b1a374de0cd9db36687df4b9e2db3e7`.
- app.asar: `d906bf328918c723b0574739ebc94b0a7447bf27761021aa73ce7d9f7349bbc2`.

This is local Linux package evidence, not a hosted producer receipt or installed/
visible UI acceptance. No application was installed or launched by extraction.
Logs: `/tmp/bc-candidate-{prebuild,electron,linux-package}.log`,
`/tmp/bc-candidate-linux-inspection.json`; extraction helper:
`/tmp/bc-inspect-linux-candidate.ts`. The isolated extraction directory was removed.

### MCP authorization browser handoff — September 23, 2026

The upstream project-scoped MCP controls already connect, disconnect and run
OAuth; the predecessor marketplace's Configure action only displayed guidance.
The migration will reuse that flow rather than add a second OAuth implementation.
Its full existing MCP suite passes **61/61** before changes. This is synthetic
transport/lifecycle/OAuth evidence, not a claim that every curated provider's
current endpoint or OAuth registration policy works.

One concrete integration mismatch was corrected: native Windows MCP OAuth used
the general `open` package under the sidecar's isolated environment, bypassing
the host-profile launcher already required by BharatCode sign-in. That launcher
now lives in Core and is shared by Desktop sign-in and MCP. Its PowerShell script
is byte-identical to the previous implementation: known folders are restored only
inside the bounded child, URL bytes enter through stdin, and failure never falls
back to an isolated-profile launch. Desktop declares the workspace dependency;
the lockfile changes only by that dependency entry.

MCP browser targets now reject non-HTTP(S) and URL userinfo on every platform.
Launch failures expose fixed safe errors. Non-Windows observation retains the
existing short launch window, with explicit terminal/cancellation cleanup and a
late-error guard until child close; this is dispatch observation, not OAuth
success. Existing callback state/PKCE handling is unchanged.

Evidence: missing-factory RED then **67/67 MCP tests, 182 assertions**, including
the original 61 plus Windows handoff/no-fallback, target validation, secret-safe
failure, cancellation, late-error and successful launcher-exit cases. The
existing Desktop browser tests pass **8/8, 24 assertions** against the shared
helper. Core, OpenCode and Desktop typechecks pass. Node sidecar and Electron
main/preload/renderer builds pass; isolated Node runtime smoke passes **2/2**.
No real browser, OAuth provider, account, protocol handler or user profile was
invoked. No Windows installed-package or WSL browser/callback acceptance is
claimed by these injected launcher tests.

Logs: `/tmp/bc-mcp-upstream-baseline.log`, `/tmp/bc-mcp-browser-{red,green,types}.log`,
`/tmp/bc-mcp-desktop-{browser,types}.log`, `/tmp/bc-mcp-core-types.log`,
`/tmp/bc-mcp-{node-build,electron-build,runtime-smoke}.log`.

### Marketplace configuration overrides and access disclosure — September 23, 2026

Marketplace responses now include a secret-free projection of the selected
runtime's **global defaults**, distinct from saved marketplace choices. Only
known IDs and enabled/custom booleans are returned; endpoints, headers, OAuth
options, commands and paths stay in the runtime. Both settings layouts disclose
custom overrides, including a separately configured connector remaining enabled
after its marketplace entry is removed. Project settings may still differ, and
these flags deliberately do not claim that a live connection is healthy.
An old runtime may omit this additive field. A successful mutation invalidates
the displayed projection until Refresh, rather than showing stale override data.

The shared global config loader has a strict fresh-read entry point for reporting.
Existing cached/defaults-on-error callers are unchanged. Malformed config gives a
safe failure, not a false all-disabled report; after the file is repaired, Refresh
recovers without restarting. The loaded defaults still require the explicit
runtime reload to apply to existing instances. No connector is started by this
projection and no project configuration is rewritten by the marketplace.

The existing expandable row now lists bundled/third-party origin, declared access
and requirements, using incumbent components and localization keys. Declared
access is not presented as a guarantee of limited permissions or an actual grant.

RED/GREEN covers custom disabled/alternate endpoints, independently configured
entries, unchanged defaults, bundled Windows skill paths, secret omission,
malformed-config recovery, and stale projection invalidation. Verification:
**30/30 Core/config tests, 150 assertions**; **238/238 OpenCode config/HTTP/OpenAPI
tests, 508 assertions** (three existing platform-specific skips); **742/742 App
tests, 3,076 assertions**; **55/55 browser-controller tests, 170 assertions**;
and **2/2 rendered marketplace flows**. Core, OpenCode, App, Desktop and legacy
SDK typechecks and the production frontend build pass. The actual legacy SDK was
regenerated, not hand-edited. Current-client generation adds no delta and its
typecheck passes. The Node sidecar rebuilt and its isolated Desktop runtime
smoke passes **2/2**. The compiled native Windows fixture passes **14 checks**,
including the configuration projection and unchanged migration/lifecycle checks.

Logs: `/tmp/bc-capability-configuration-{core,opencode,http-green}.log`,
`/tmp/bc-capability-config-retry-red.log`,
`/tmp/bc-marketplace-config-{app-tests,browser,build,e2e}.log` and corresponding
typecheck files. All fixtures are isolated; no install, account or real-profile
mutation. Connector OAuth/setup, live connection health, final branding/release
integration and installed-package acceptance remain open.

### Marketplace lifecycle controls in both settings layouts — September 23, 2026

Both settings layouts now expose the selected runtime's marketplace through the
generated SDK: install disabled, explicit enable/disable, remove, refresh, and
confirmed runtime reload. The existing settings components, hierarchy and tokens
are retained. Runtime changes and disposal abort requests and reject stale reads
or mutations; duplicate actions are suppressed. A failed mutation or reload has
an uncertain outcome, displays only fixed safe copy, and requires an authoritative
refresh before another mutation. It never automatically retries publication or
claims an unconfirmed change was saved. Reload warns that active sessions will
be interrupted and is never triggered silently after a settings change.

Evidence: **742/742 App unit tests, 3,076 assertions**; **55/55 browser-controller
tests, 169 assertions**; App and Desktop typechecks and the production frontend
build pass. The two production-frontend browser fixtures exercise both layouts,
including a mutation that commits but returns a synthetic 503, refresh recovery,
all four lifecycle actions and explicit reload. No real MCP, OAuth or application
profile is involved; external traffic is blocked. The fixtures must use the same
server and preview port because production web routing uses the page origin.
An initial mismatched fixture port failed before settings and was corrected in
the test invocation, not by changing application routing. The unconfirmed-save
label also has a rendered RED/GREEN regression.

Logs: `/tmp/bc-marketplace-{app-tests,browser-final,app-types-final,desktop-types}.log`,
`/tmp/bc-marketplace-ui-build-final.log`, `/tmp/bc-marketplace-e2e-final.log` and
`/tmp/bc-marketplace-save-red.log`. Screenshots are local synthetic evidence at
`/tmp/bc-marketplace-{legacy,new}.png`.

This completes lifecycle controls, not the full marketplace: effective custom
configuration status, permission/trust details, connector setup/authentication,
live connection health and matching installed-package acceptance remain open.
Nothing was installed, published, or changed in a real profile.

### One-time marketplace choice migration — September 23, 2026

Native Desktop now imports the previous Electron `bharatcode.capabilities`
`state.v1` record before its sidecar starts serving requests. The runtime owns
the new record; no renderer mutation or new credential-bearing IPC was added.
WSL and remote runtimes do not receive the native host's old choices. A new-format
record wins over the legacy source, including if that source later becomes
malformed. Migration and ordinary changes share the same lock/publication path,
so a committed import cannot replay over subsequent user choices. Old source
bytes are never rewritten or removed.

The private record retains only known capability IDs and enabled flags, plus
internal ownership IDs that are omitted from API responses. Both config loaders
ignore only exact predecessor-generated MCP shapes in the global
`opencode.jsonc`, and the predecessor's reserved bundled-Superpowers resource
paths. Custom URLs, headers, environment, extra options, disabled overrides,
unrelated entries, other config files and project overrides remain authoritative.
This filtering is in memory: original config bytes/comments are unchanged.

An integration regression also exposed upstream's v1-format detector dropping
files containing only legacy MCP/skills settings. Detection now recognizes those
changed shapes while retaining the v2 server-map/skills-array forms.

Evidence: migration methods and both loader integrations first failed focused
tests, then passed **28/28 core/config tests, 140 assertions**, and **114/114
legacy-config/HTTP tests, 210 assertions**. Core, OpenCode and Desktop typechecks
pass. Compiled native Windows fixtures pass **12 lifecycle/security checks**,
including disabled-choice preservation, repeat import, unchanged old source,
hardlink rejection and malformed-source rejection. The Node sidecar rebuilt;
the existing Desktop runtime smoke passes **2/2**, now exercising import before
listening, protected marketplace state without internal metadata, signed-out
account state, and SQLite draft close/reopen. That test uses Desktop's existing
PTY resolution adapter because the intermediate bundle is emitted under
OpenCode, not the final Desktop package.

Logs: `/tmp/bc-capability-migration-{core-final,opencode-final,node-build}.log`,
`/tmp/bc-capability-migration-runtime-smoke-final.log`, and the corresponding
`*-types-final.log` files. The Windows fixture is reproducible from
`packages/core/test/fixture/capabilities-native.ts`.

All mutations were confined to fresh fixtures and local source/build output.
No application install, real profile, config, credentials, or protocol handler
was changed. This is implementation/runtime-fixture evidence, **not an installed
upgrade acceptance claim**. Both settings layouts, effective override/status
presentation, connector setup/authentication and final package acceptance remain.

### Protected marketplace API and SDK — September 23, 2026

The selected runtime now exposes catalog/state reads and bounded capability
changes through the existing authorized instance HTTP API. Responses contain
public catalog metadata and enabled flags only, not MCP commands, environment,
headers, credentials or filesystem paths. Unknown IDs, invalid actions and extra
payload fields are rejected. Storage failures return a fixed retry-safe message;
clients must re-read state before retrying an unconfirmed mutation.

Changes invalidate cached configuration but do not dispose active sessions or
pretend that live MCP connections have changed. The mutation response explicitly
requires a runtime reload. Both layouts must present and apply that reload
deliberately when their settings integration is completed.

The legacy SDK was regenerated and its actual client exercised against the
protected handler. Current-client regeneration produced no delta (these instance
routes belong to the legacy SDK transport). **58/58 HTTP/account/config/OpenAPI/
SDK tests, 283 assertions** passed. OpenCode, legacy SDK and current-client
typechecks pass using the current local Node runtime; the first current-client
typecheck picked up obsolete system Node and failed before checking source.
Logs: `/tmp/bc-capability-http-final.log`,
`/tmp/bc-capability-http-types-final.log`,
`/tmp/bc-capability-client-types.log`, and
`/tmp/bc-capability-sdk-types.log`.

No connectors were launched and no real profile or installed application was
changed. UI and installed acceptance remain open. The migration checkpoint above
addresses old generated MCP settings overriding subsequent Disable actions while
preserving original config bytes and prior disabled choices.

### Runtime-owned marketplace foundation — September 23, 2026

The retained main-process marketplace deleted every recognized MCP name from the
Windows config before rewriting it, and could not target a WSL runtime safely.
Its replacement keeps a bounded, validated install/enable record inside the
selected runtime's data root. It does not edit user configuration. Both the legacy
configuration loader and new core configuration loader now place these defaults
below explicit user settings. Custom MCP endpoints, disabled entries, unrelated
servers and original config bytes are preserved by the scoped tests.

The nine retained catalog entries are carried forward. Curated connectors install
disabled; enabling is explicit. Superpowers remains the Desktop default, not an
automatic new CLI default, and an explicit disable survives restart. Its 61
retained assets were compared byte-for-byte with `origin/dev` at `3d8360d79261`;
the previously missing [upstream MIT license](https://github.com/obra/superpowers/blob/main/LICENSE)
is also bundled. Assets are embedded as data so the same compiled runtime can
materialize its own content-addressed skill directory on Windows, Linux/WSL or
macOS. Materialization executes no bundled scripts and rejects altered/link
targets rather than overwriting them.

State changes serialize with the existing filesystem lock. POSIX publication
flushes a sibling temporary file, renames and syncs the parent. Native Windows
reuses the existing held-object/private-publication helper, with private-parent
preparation before lock creation. An unconfirmed publication remains an error;
there is no automatic mutation replay. Existing ACLs are not rewritten. This is
the tested protocol, not hardware power-loss certification.

Evidence: missing-module RED; **22/22 core/config tests, 102 assertions**, and
**109/109 legacy config tests, 187 assertions** GREEN. Core and OpenCode typechecks
pass. Tests include restart, independent runtime roots, concurrent changes,
uninstall, disabled defaults, malformed state, altered bundled files and POSIX
hardlink/symlink/broad-permission rejection. A compiled native Windows fixture
first failed first-use storage ordering, then passed all five lifecycle checks
after private-parent preparation moved before lock creation. It used only a new
temporary root and cleaned it afterward. Reproducible fixture:
`packages/core/test/fixture/capabilities-native.ts` (bundle with Bun's Node/CJS
target, then run with native Node). No connector or real account was contacted.

Logs: `/tmp/bc-capabilities-{red,core-final,legacy,types,opencode-types}.log`.
**Not yet complete:** both settings layouts,
effective override/status presentation,
connector authentication/setup, and matching installed-package acceptance.
Prior Electron-store choices now have a migration implementation and isolated
runtime proof above; a replacement still requires installed-upgrade acceptance.

### Dictation composer and microphone permission — September 23, 2026

Both composer layouts now use the selected runtime's generated account API for
dictation. The compact control appears only after that runtime reports an eligible
speech model and a valid input limit; stale availability while switching runtimes
cannot enable recording. There is no hard-coded model or renderer bearer token.
Start/stop, cancel/Escape and the retained Cmd/Ctrl+Shift+M shortcut are wired.
Recordings stop after two minutes or at the advertised byte limit, whichever
comes first. Transcription never submits a prompt automatically.

The controller releases microphone tracks on cancellation, failure, navigation
and disposal, suppresses duplicate starts/stops, aborts uploads, and rejects late
permission/transcript results after a runtime/session change. Insertion uses a
text node and the existing editor input event; failed transcription preserves
the existing draft and exposes only localized fixed error text.

The upstream Electron permission allowlist denied all microphone requests. It now
permits audio only from the trusted main frame of the owning window; camera,
mixed media, unknown media, other windows and untrusted frames remain denied.
macOS packaging now includes the microphone usage description; its existing
audio-input entitlement is unchanged.

Evidence:

- Controller RED (missing implementation), then five tests / 22 assertions GREEN.
- Full App unit **742/742, 3,076 assertions** and browser-controller
  **50/50, 147 assertions** pass. App and Desktop typechecks pass.
- Permission/packaging RED, then **3/3, 29 assertions** GREEN.
- Fresh production frontend build and **2/2 Chromium tests**, one per composer,
  pass. Synthetic microphone/audio and mocked runtime responses cover error and
  retry, preserved draft, literal insertion, cancellation without upload, and
  hiding the control when speech is unavailable. No live credentials, account,
  microphone recording or speech-provider request was used.
- Bounded screenshots confirm the existing compact toolbar style is preserved.
- Production timeline smoke before/after: no wrong-destination, blank, unknown or
  replaced-review-host samples. One trial each, 72 review diffs: closed cold
  46.4→105.4 ms; closed hot 33.0→48.2 ms; open cold 59.2→92.8 ms; open hot
  45.8→65.4 ms to stable. These timings increased in this single local sample;
  this is not statistical performance clearance or an improvement claim.

Logs: `/tmp/bc-dictation-ui-{types,build-final,e2e-final}.log`,
`/tmp/bc-dictation-app-tests-final.log`,
`/tmp/bc-dictation-permission-red.log`, and
`/tmp/bc-dictation-timeline-{before,after}.log`.
Real-device Electron/OS permission and packaged microphone acceptance remain
pending. Current live speech availability is not established by these mocks.

### Dictation runtime boundary — September 23, 2026

The previous Desktop implementation hard-coded a retired Whisper model and read
its bearer token in main before upload. The new runtime-owned service selects only
an eligible live transcription model from the catalog and rechecks availability
before upload. It uses the shared authenticated account fetch at the fixed
BharatCode transcription endpoint; callers cannot choose an upstream URL or
provide a credential. Recordings have a strict MIME/base64 contract and a 16 MiB
ceiling further reduced by the live model's advertised input limit. Upload and
response reading have a shared deadline. Provider payloads are never returned in
errors; access denial is distinct from needing to sign in.

GET/POST `/account/dictation` use the existing sidecar authorization boundary and
structural SDK schemas. No live speech model means `available: false`, not a
fallback to Whisper. The legacy SDK is regenerated from the actual routes. The
current client generator also picked up the earlier canonical optional Goal
field in list/create/get projections; its generated output was not hand-edited.

Tests first reproduced the missing dictation service, then passed **79/79,
424 assertions** across account/catalog/dictation/HTTP/OpenAPI suites. OpenCode
and current-client typechecks and SDK generation pass. Logs:
`/tmp/bc-dictation-{red,green,http,final,types,sdk,client,client-types}.log`.
The obsolete account fixture asserting that signed-out users cannot discover the
public catalog now checks the actual shipped signed-out account boundary; public
discovery is covered separately without a live network dependency.

The renderer integration and mocked browser acceptance are now covered by the
checkpoint above. Neither checkpoint establishes live speech-service availability.
The marketplace audit remains open: the old main-process Windows config writer
must not configure a selected WSL runtime.

### Repeated tool-failure protection — September 23, 2026

Reconciled the retained fork's `ToolLoopGuard` against both the compatibility
processor and the new core runner. A shared, schema-independent helper compares
canonical input fingerprints (object key order does not matter; array order does).
Three identical failed calls in the last 80 messages block the next identical
local call before its side effects and stop automatic continuation. Different
tools/inputs and successful calls are not counted. Unencodable inputs are not
collapsed to a common identity. Diagnostic metadata contains hashes, not raw
arguments or error payloads.

The compatibility processor now persists and settles blocked calls, including
built-ins, MCP tools and resource helpers. Its existing doom-loop permission
check also uses canonical hashes instead of raw input metadata. The core runner
records the blocked tool result through its normal event publisher and stops the
continuation without delegating to the old engine. Provider-executed tools are
not intercepted after the provider has already executed them.

RED: the core fixture made five model turns rather than stopping at four, and
the legacy resolver attempted tool side effects instead of blocking. GREEN:
core runner/registry/event/helper suites **113/113, 323 assertions**; compatibility
processor/tools/compaction/Goal-assessment suites **81 pass, 1 existing skip,
262 assertions**. The actual core fixture asserts exactly three executions and
a persisted fourth-call error; the compatibility HTTP fixture asserts a persisted
block and `stop`. Core, OpenCode and Desktop typechecks pass. Logs are under
`/tmp/bc-tool-loop-*.log`. Installed-package acceptance is still pending.

### Public catalog / authenticated execution boundary — September 23, 2026

Compared the Desktop adapter with the platform repository's cached `origin/main`
catalog exception (`e696cfb16`): only GET `/api/model/v1/models` is public.
Discovery now uses that exact endpoint without account storage, token refresh,
cookies, or redirect following. Its shared metadata cache remains bounded by TTL,
supports explicit refresh, and serializes concurrent discovery. Headers and body
share a 15-second timeout. Failed responses cannot populate an empty cache or
expose provider payloads; a public gateway 401 no longer falsely asks the user to
sign in. Model parsing, eligibility and strict metadata checks remain intact.

Generation still uses the existing native account adapter. Executable regressions
confirm that subscription/restriction/rate-limit/not-found/verifier-outage responses
do not refresh, replay or erase valid credentials, and an already-started SSE
response is never replayed. Existing single-flight 401 refresh/account-switch
tests remain green. No authentication or subscription enforcement was removed.

Evidence: public-discovery tests first failed because the old adapter required an
account service (4 RED); the combined catalog/account/model/provider tests now
pass **51/51, 190 assertions**. OpenCode typecheck passes. Evidence logs:
`/tmp/bc-public-catalog-{red,green,all,types}.log`. This is local source/test
evidence, not a claim about a newly built installer or current production uptime.

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

Remaining, updated after the September 23 checkpoints:

1. Finish the retained capabilities/marketplace and branding/assets audit and
   integration. Dictation, error/recovery UI, Goal ribbon and repeated-tool-failure
   protection are locally implemented and tested as detailed in the checkpoints;
   dictation still needs real-device/package acceptance.
2. Complete native package verification of the implemented WSL provisioning and
   runtime/account isolation. Do not reinstate the legacy startup recovery gate.
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

| Scenario            | Before stable (ms) | After stable (ms) |
| ------------------- | -----------------: | ----------------: |
| Review closed, cold |               47.7 |              48.0 |
| Review closed, hot  |               29.6 |              28.9 |
| Review open, cold   |               70.8 |              69.5 |
| Review open, hot    |               61.2 |              54.9 |

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

### WSL prerequisite/working-directory cleanup — September 23, 2026

The bundled-runtime path no longer probes or requires curl. Bash remains required
for the Linux coding shell. Removed the unused curl field and obsolete missing-
tools translations; the new missing-shell label uses the existing English fallback.
WSL setup labels now identify BharatCode rather than advertising installation of
upstream OpenCode. Internal IPC/type names remain compatibility names.

Production WSL launch now explicitly starts in the verified Linux user's home,
matching the native smoke's working-directory behavior instead of inheriting the
Windows application's directory. Added a failing-then-passing argv regression.
The project picker already uses the selected WSL server's filesystem (not the
native Windows picker); an explicit WSL policy assertion now covers that choice.
No new Windows-path translation layer is required for that picker. Installed
Electron interaction/attachment acceptance remains outstanding.

Focused controller/transport/artifact tests: **37 pass**, 119 assertions,
including the working-directory assertion. Full App unit suite: **741 pass**,
3072 assertions. Desktop and App typechecks pass. These are local tests, not a
new native-installed acceptance run. No live distro installation, profile or
account changes were made.

### SDK regeneration and schema correction — September 23, 2026

Regenerated the consumed legacy-compatible `@opencode-ai/sdk/v2` from the actual
HTTP API. Goal fields/update actions and the account endpoints are now typed and
serialized by that SDK. No generated file was hand-patched; the existing build
script's narrowly scoped upstream-generator corrections remain in use.

The first regeneration failed its duplicate-event-schema guard. Root cause:
account input schemas used `Unknown -> Struct`, so their encoded OpenAPI shape
was unknown; the shared unknown metadata shape acquired an account-request
reference, producing duplicate event variants. Replaced these with structural
schemas and the supported `onExcessProperty: error` annotation. Actual HTTP tests
still reject extra/substituted fields. The new OpenAPI regression was RED before
the correction and GREEN afterward; the duplicate-schema guard was not weakened.

Evidence: account/OpenAPI suites **24 pass**, 203 assertions; SDK tests **2 pass**;
SDK build/typecheck, OpenCode typecheck and Desktop/App typecheck pass. Two isolated
generations produced identical generated-file hashes:
`sdk.gen.ts` = `ea63af06a3022326c5079e66df9a55a10eeb401ae408009651b8531cd967c867`;
`types.gen.ts` = `e6c04f48b4b18a29b7160fe34a98bcc051d0992c551541c194c3f9920dad01cd`.
Generator execution used fresh temporary homes/XDG roots, removed afterward.

This is **not** complete SDK/new-layout acceptance. App and session-ui also consume
the vendored `@opencode-ai/client` 1.17.13-v2 tarball. The local workspace client
exports a different Promise surface (plural groups, no `/promise` alias), and the
current server protocol does not expose every endpoint that vendored client
advertises. Replacing the tarball with a workspace alias without reconciling those
contracts would be incorrect. That separate integration and Goal Mode's UI/v2
session behavior remain open; no publication or installed-app acceptance claimed.

### Goal Mode renderer and session projection — September 23, 2026

Restored the compact Goal Mode ribbon on the shared composer, using the existing
UI components and shared English fallback. Save, pause/resume and clear use the
actual directory-scoped session-update endpoint. Pending actions are single-flight;
failed edits retain their draft and show fixed safe copy, not transport payloads.
Session/runtime changes and disposal invalidate late UI completions. Text is
bounded to the backend's 4,000-character limit. The elapsed timer is active only
while the goal is active and is cleaned up with its owner. Completed goals retain
the previous behavior of leaving the ribbon; blocked goals keep their report.

Two RED regressions identified lost state: the V1-to-current adapter omitted the
goal, and the current DB-to-session projection omitted it too. Both are corrected.
The goal schema is now one shared browser-safe contract, re-exported through the
legacy compatibility surface with unchanged identifiers. The duplicated SQL-only
type is removed. SDK regeneration adds the goal to the current session-read type.
The production test fixture now mirrors that actual response field.

Fresh evidence:

- App unit tests: **742 pass**, 3,076 assertions; browser-condition controller
  tests: **45 pass**, 125 assertions (including duplicate submission, failed edit,
  runtime switch, A-to-B-to-A navigation and disposal).
- Real Chromium, production-built renderer: **2 pass**, exercising both layouts,
  literal text rendering, safe failure/retry, pending controls, pause/resume,
  clearing and persistence over reload. These use synthetic HTTP fixtures, not
  real accounts or an installed app. Legacy layout uses a pre-sunset test clock
  and its legacy route; upstream's September 14 retirement policy is unchanged.
- Goal/backend/OpenAPI suites: **45 pass**, 259 assertions. Core SQLite projector
  suite: **10 pass**, 23 assertions. Focused schema compatibility/hygiene: **9 pass**,
  21 assertions. SDK contract tests: **2 pass**. SDK build and App, Core, Schema,
  OpenCode, Desktop and E2E typechecks pass.
- Full Schema suite has two inherited manifest-count/positional assertions that
  fail on unchanged `dc2284bd1f` too: baseline **13 pass / 2 fail**. This checkpoint
  does not label that suite green; the separate correction below closes that item.

Production session-tab benchmark (one trial per scenario, 72 review diffs):

| Scenario            | Before stable (ms) | After stable (ms) |
| ------------------- | -----------------: | ----------------: |
| Review closed, cold |               53.1 |              59.9 |
| Review closed, hot  |               32.4 |              31.5 |
| Review open, cold   |               55.8 |              63.0 |
| Review open, hot    |               46.5 |              60.4 |

All trials had zero wrong-destination, blank, unknown or replaced-review-host
samples. This is a bounded regression smoke, not a statistically measured speed
claim. Logs: `/tmp/bc-goal-timeline-before.log`, `/tmp/bc-goal-timeline-after.log`,
`/tmp/bc-goal-production-browser.log`. The first browser experiments included
development-server hot reload while source was changing; final renderer checks
were serial against a fixed production build.

Goal controls are gated to the bundled V1-compatible runtime protocol (independent
of which visual layout is active). Reading current session responses now preserves
goals, but this does not invent Goal execution support for an external pure-v2
server. The vendored-client surface audit, remaining retained features, release
workflows and exact native-package acceptance still remain. No publication,
installation, protocol registration, real account or profile changes were made.

### Upstream event-manifest test correction — September 23, 2026

The two baseline schema failures came from upstream's three durable revert events
(`staged`, `cleared`, `committed`) being added without updating the manifest test.
No runtime event definitions were changed. Updated the existing inventory counts
and checked canonical definitions by event type instead of their array positions;
the revert events must also resolve to their exact durable definitions. The full
Schema suite now passes **16 tests**, including the new shared Goal schema check.

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
   dependency closure of what we ship over upstream's _current_ graph rather
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

| Theme              | Scope (our delta since the fork)                                                   | Notes                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **cli-core**       | `src/cli` 28 files +1,035; `src/session` 13 files +877; `src/server` 28 files +581 | `prompt.ts` is the hard one: 220 ours over a 667-line upstream rewrite. Unblocks the Goal Mode HTTP handler. |
| **desktop-shell**  | 338 files, +27,680                                                                 | The single largest body of work, but only ~12% contested.                                                    |
| **app-ui**         | `packages/app` 86 files +4,112; `packages/ui` 81 files +324                        | Includes re-homing the Goal Mode ribbon.                                                                     |
| **ci-release**     | `.github` 48 files, +8,471                                                         | Re-author from the current workflows, not commit by commit.                                                  |
| **tests**          | 75 files, +12,448                                                                  | Prune while replaying.                                                                                       |
| **sdk + lockfile** | generated                                                                          | Regenerate last, after Goal Mode and bharatcode-core are in.                                                 |

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
  two steps _later_. The dependency graph, not the overlap percentage, decides
  the order.
- **Goal Mode** (0% overlap) built fine and silently did nothing. Sessions are
  event-sourced now: `Session.patch` publishes `SessionV1.Event.Updated` and a
  projector in `core` writes the row. A new session field has to exist in the
  schema the _event_ carries and be mapped by the projector, or it is dropped on
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

| Was (fork point)                                          | Is now                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `AppFileSystem` (`core/filesystem`)                       | `FSUtil` (`core/fs-util`) — old export **gone**                                   |
| `Schema.Defect`                                           | `Schema.Defect()`                                                                 |
| `Schema.Class` for `ProviderV2.Info` / `ModelV2.Info`     | `Schema.Struct` — `new X({...})` → `X.make({...})`                                |
| `export const layer` / `defaultLayer`                     | `export const node = LayerNode.make(...)`; compile with `LayerNode.compile(node)` |
| `core/util/log`, `Log.Default.warn`                       | `Effect.logWarning(msg, {...})`                                                   |
| `@/effect/service-use`                                    | `@opencode-ai/core/effect/service-use`                                            |
| `@/provider/schema` (`ProviderID`, `ModelID`)             | `ProviderV2.ID`, `ModelV2.ID`                                                     |
| `MessageV2.WithParts` / `TextPart` / `Assistant` / `User` | `SessionV1.*` from `core/v1/session`                                              |

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
