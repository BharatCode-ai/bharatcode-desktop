# Upstream catch-up — status

Branch `chore/upstream-catchup-2026-09`, cut from `upstream/dev` @ `fee476bb90`
(anomalyco/opencode, 2026-09-19).

We had not synced since the fork point `6b03be5468` (2026-05-23): upstream was
2,423 commits ahead, we were 298 ahead. This is a re-fork, not a merge — start
from upstream and re-apply our work theme by theme, evaluating each one, rather
than resolving 499 overlapping files at once.

## Where it stands

### Retained Desktop route restoration — September 23, 2026

The new Desktop shell already restores a window-scoped URL through
`DesktopMemoryRouter`, before shared App layout initialization. The absence of
the old `app-startup.ts` helper is **not** evidence of lost restoration. Extracted
that existing router verbatim into `desktop/src/renderer/router.tsx` so a browser
fixture exercises the actual shipped implementation, rather than a lookalike.
No startup behavior, storage keys, profile data, or authentication policy changed.

An initial fixture incorrectly used a plain memory router, then omitted the
Desktop full-height root container. Those failures are fixture defects, **not
product RED evidence**. The redundant proposed startup fallback was removed
before commit; it must not compete with the existing router or override a
deliberately saved Home route.

Real Chromium with the actual router, asynchronously hydrated synthetic Desktop
storage, and mocked V1 backend passes **5/5**: both layouts reopen the selected
older conversation and messages after navigation/reload; Home remains Home;
two window IDs retain independent routes; a failed session lookup preserves the
saved URL and a later reload recovers. App **745/745**, browser-condition **55/55**,
Desktop **141/141**, Desktop/E2E typechecks, and production App build pass.
The E2E typecheck now includes the full imported App surface and extracted router.
The fixture is not shipped, does not use an authentication bypass, and makes no
real account/network/model request. This is renderer integration evidence, not
installed close/reopen or OS window-lifecycle acceptance. Logs:
`/tmp/bc-startup-{real-router,e2e-types,desktop-tests,desktop-types,app-tests,app-build}.log`.

### Retained dependency security versions — September 23, 2026

Restored DOMPurify 3.4.11 from accepted `e252c31658` at its new consumer,
`session-ui/markdown-cache.tsx`, using the shared dependency catalog. Removed
the unused UI-package DOMPurify dependency and the unused OpenCode-package
minimatch dependency; actual glob matching already lives in Core and retains
the accepted minimatch 10.2.5 pin. The obsolete 10.0.3 package and its two orphaned
dependencies disappear from the lockfile. No sanitizer options were weakened.

Frozen install passes. Session UI **83/83**, App **745/745**, browser-condition
tests **55/55**, production App build and all **19/19 workspace typechecks** pass.
Real Chromium against the production renderer passed **4/4**: both layouts
remove scripts/styles/frames, event handlers and javascript URLs while preserving
safe markdown and noreferrer/noopener links; compaction visibility remains green.
No production network/account was used.

The previous E2E typecheck did not include `session-compaction.spec.ts`, so that
earlier claim was narrower than intended. Both new safety and compaction tests
are now explicitly included with their fixture dependencies. Corrected the
fixture's literal-ID/optional-text typing; the expanded E2E typecheck passes.
Logs: `/tmp/bc-security-{deps-install,deps-frozen,session-ui,session-ui-types,
app-tests,app-build,browser,e2e-types,all-types}.log`.

### CLI terminal completion and output — September 23, 2026

The subprocess audit exposed a deferred-capture integration regression: updating
the stored step's snapshot emitted a second `step_start` JSON record. CLI output
now announces each step ID once without discarding the stored snapshot update.
Existing JSON-ordering tests went from **10 pass / 3 fail** to **13/13**.

The accepted `b6db9d469d` completion policy was also missing. A new 1.3 MB reply
fixture reproduced attached CLI exit with zero output; merely awaiting terminal
idle still truncated output to 219,264 bytes. Restored the small completion helper
and its tests: both submission and terminal completion must settle, prompt errors
do not wait for nonexistent idle events, early stream closure fails, the deadline
includes submission, cleanup cancels the event/request subscription, and queued
stdout writes drain before return. Local and attached subprocesses now retain the
entire reply and final sentinel. No interactive-runtime redesign was made.

GREEN: **27/27, 72 assertions** across completion-helper and actual subprocess
tests, including JSON/text/reasoning/tool order, unknown model, permission denial,
attached file handling and SIGINT. OpenCode typecheck passes. Logs:
`/tmp/bc-cli-retained-{baseline,green,types}.log`,
`/tmp/bc-cli-step-green.log`, `/tmp/bc-cli-output-{red,green}.log`.
The intermediate output-green filename contains the deliberately insufficient
wait-only attempt, not final passing evidence; final GREEN is retained-green.
All HTTP/model traffic was local synthetic fixture traffic.

### Downloaded search-tool integrity — September 23, 2026

The accepted `58ef562c50` checksum policy was missing from upstream's relocated
`packages/core/src/ripgrep/binary.ts`. Restored all seven unchanged ripgrep
15.1.0 archive pins and verify the downloaded bytes before writing an archive or
starting extraction. System/cached binary selection and the upstream extractor
remain unchanged. Removed the unused HTTP-client import in the touched module.

RED: hostile bytes reached the extraction boundary. GREEN: downloader/search
**6/6**, Core typecheck, and full Core **1,123/1,123, 3,125 assertions**.
An additional Linux smoke used the real downloader with a fresh isolated home,
no system ripgrep in PATH, the actual pinned GitHub archive, and real extraction:
`rg --version` returned 15.1.0 and a second resolution reused the cached binary.
The entire temporary home was removed afterward. No user installation/profile
was used. Logs: `/tmp/bc-ripgrep-{red,green,types,core-suite,native}.log`;
the live archive test is Linux-only, not a cross-platform execution claim.

### Deferred workspace capture — September 23, 2026

Ported the accepted `9343b71ea3` behavior to the current Effect processor without
copying its old lifetime/deduplication mechanism. Processor creation no longer
waits on workspace capture; text streams while one cached capture runs. Every
local tool execution awaits that capture, including SDK callbacks which precede
`step-start`. The owning fiber starts immediately, and the callback bridge retains
workspace context. Step records receive the original tree before final snapshot
and patch computation. Each step resets capture state even when snapshots are
disabled. Cleanup cancels unfinished filesystem work; tools cannot execute after
abort/completion or a capture failure.

RED: all three initial slow-capture fixtures timed out at processor creation.
GREEN: seven added regressions cover early text, concurrent tools, abort, capture
failure, provider failure, pre-event execution, multiple steps and disabled
snapshots. The session/snapshot suites passed **497 tests / 8 existing skips /
1 existing todo / 0 failures, 1,974 assertions**, including actual isolated Git
snapshot/tool diff behavior. OpenCode typecheck passed. Logs:
`/tmp/bc-snapshot-{red,edge,session-suite,final,types}.log`.
All model responses are synthetic and filesystem operations use isolated roots;
this is not a production latency measurement or installed-package acceptance.

### Overflow compaction context and timeline — September 23, 2026

Reproduced the accepted `3392af2a3c` regression against the current upstream
runtime. With an explicit overflow compaction marker, the summary input stopped
before the latest real user turn, dropping its assistant progress and completed
tool output before replaying the prompt. The summary now includes history up to
the compaction marker; non-marker behavior and upstream retained-tail selection
are unchanged. The regression verifies prior context, the latest request,
assistant progress and completed tool output in the summary, with only the user
request replayed afterward (no duplicated tool part).

The corresponding old timeline safeguard was also missing after the rows module
moved. It now hides internal summary messages on compaction turns while retaining
the divider and actual continuation text. Existing latest-error semantics on
ordinary turns remain intact. This is a data-projection correction, not a visual
redesign; Impeccable hardening guidance was used to preserve incumbent components
and copy and check both layouts. Mechanical detector: no findings.

Evidence:
- Compaction RED **55 pass / 1 skip / 1 fail**; GREEN **56 pass / 1 existing skip,
  174 assertions**. The skip is the upstream disabled-v2-projector case, not a
  passing migration result.
- Timeline RED **5 pass / 1 fail**; full App GREEN **745/745, 3,091 assertions**.
- OpenCode, App and E2E typechecks pass. Real Chromium against the production
  build: **2/2**, legacy and new layouts, using synthetic V1 responses matching
  the bundled runtime contract. Screenshots inspected at
  `/tmp/bc-compaction-{legacy,new}.png`; no internal handoff text is visible.
- Production session-tab benchmark passed before and after (one V2 trial per
  scenario, 72 review diffs; also the existing legacy trials). V2 stable times
  before → after: closed/cold **101.8 → 109.0 ms**, closed/hot **53.1 → 51.2 ms**,
  open/cold **80.8 → 87.4 ms**, open/hot **56.2 → 69.0 ms**. Zero wrong, blank,
  unknown, missing or replaced review-host samples. This is bounded functional
  performance evidence, not a statistical speed claim.

Logs: `/tmp/bc-overflow-context-{red,green,types}.log`,
`/tmp/bc-overflow-rows-red.log`, `/tmp/bc-overflow-app-{green,types}.log`,
`/tmp/bc-overflow-e2e-types.log`, `/tmp/bc-overflow-browser.log`,
`/tmp/bc-overflow-timeline-{before,after}.log`. All data/processes were isolated;
no installed app, real conversation or provider request was used.

### Runtime upgrade/uninstall identity — September 23, 2026

Restored the accepted `4c392628bb` distribution-policy behavior against the new
Effect runtime. Version lookup, installer URL, npm/bun/pnpm upgrade targets,
brew tap/formula, Scoop/Chocolatey identity and uninstall now consume the existing
`DISTRIBUTION` metadata. The two duplicate uninstall command maps were replaced
by one shared command builder consumed by both the summary and execution path.
Internal `@opencode-ai/*` imports and compatibility config names are unchanged.

RED: four installation fixture regressions on the old runtime. GREEN:
installation **18/18**, with captured command/HTTP assertions covering the npm
family, GitHub, curl, brew, Scoop, Chocolatey and uninstall targets. Combined
installation/retry/sharing **87/87** and OpenCode typecheck pass. Every process
and HTTP operation in these installation tests is synthetic; no actual package
manager, downloaded installer, upgrade, uninstall or release API was invoked.
Correct product identity does not assert a public brew/Scoop/Chocolatey package
currently exists. Logs: `/tmp/bc-install-identity-red.log`,
`/tmp/bc-final-retained-guards.log`, `/tmp/bc-final-retained-types.log`.

The checkpoints above close overflow compaction (`3392af2a3c`), deferred
workspace capture (`9343b71ea3`), downloaded-tool integrity (`58ef562c50`) and
noninteractive CLI termination (`b6db9d469d`) against their new upstream owners.

### Retained sharing and DNS safeguards — September 23, 2026

Auditing the accepted release history found two omitted runtime policies.
The permanent `ENOTFOUND` fail-fast rule is restored in the bundled V1 retry
path; temporary `EAI_AGAIN` remains retryable. The new upstream retry delays,
jitter and bounded retry count are preserved. The V2 runner has no corresponding
automatic provider retry loop to patch.

The existing `SHARE_NEXT_ENABLED=false` flag had become dead code while upstream
sharing remained reachable. Shipped builds now consume that gate through the
existing ProductPolicy and reject request/create/remove/public-URL operations
with the established safe unavailable error before any sharing network request.
Background sharing remains inactive. Generic internal upstream fixtures keep
their original behavior; no new sharing provider, credential reader or API was
introduced. The compiled beta fixture verifies POST/DELETE rejection, unchanged
unshared session state and zero external fetch attempts.

Both omissions have RED regressions. GREEN: retry/sharing **69/69, 124
assertions**, OpenCode typecheck, compiled Node account/SDK lifecycle **2/2**.
Logs: `/tmp/bc-dns-red.log`, `/tmp/bc-share-gate-red.log`,
`/tmp/bc-retained-guards-green.log`, `/tmp/bc-retained-guards-types.log`,
`/tmp/bc-retained-node-smoke.log`. No live sharing or provider calls occurred.

The audit also found upstream package identities still in runtime installation,
upgrade and uninstall. The separate distribution checkpoint above closes that
finding; the full retained-feature audit is not yet complete.

### Native Windows-to-WSL argument boundary — September 23, 2026

A real native Windows launcher test exposed a production defect: `wsl --`
invokes the default shell, consuming backslashes in Windows artifact paths.
The same `wslpath` input succeeds with `--exec`. All command callers now share
the small production argv builder using `--exec`; explicitly requested `sh`
scripts remain explicit, while interactive terminal launch is unchanged.
The native smoke previously had its own correct argv construction, masking
the production defect. It now consumes the production helper instead.

RED: two argv regressions failed. GREEN: WSL source suite **38/38**, full
Desktop **141/141, 451 assertions**, Desktop typecheck. The native smoke now
also checks literal backslashes/metacharacters, drive-path translation,
private runtime provisioning, signed-out account status, project paths with
spaces, session creation and persistence across two real WSL processes,
authenticated readiness, idempotent acknowledged shutdown and closed ports.
It passed with native Windows Node and the compiled non-root Linux runtime
from clean source `31d8d49650d7767e0d4495a95f0d42e1cd10c154` (SHA-256
`4c73080e719562d8af2f9d6236860e37c2d7826a76db8fab8d96c568cded7c65`).
That first pass used the pending corrected Desktop harness, not a same-SHA
packaged cohort. Exact-source rebuilding follows the corrective commit.

The subsequent clean **5d20fa1450bd18a3b47a4b0699b7cd8404419a91** build and
native Windows script passed the full same-source lifecycle. Runtime SHA-256:
`7874c3e0ae7593e9fe4f99cd4a08f5ce716dc3551eec84b8c8b2208de60cdc33`.
The compiled Linux transport suite also passed **3/3, 33 assertions**, including
EOF shutdown. This establishes the actual Windows/WSL process boundary, not
installed Electron UI or a completed cross-platform package cohort.

Only freshly created test roots were mutated and removed. No installed app,
protocol handler, real credentials, model requests or user profile was used.
Logs: `/tmp/bc-wsl-args-red.log`, `/tmp/bc-wsl-args-green.log`,
`/tmp/bc-wsl-desktop-full.log`, `/tmp/bc-wsl-args-types.log`.

### Provider fixtures and refreshed Linux packages — September 23, 2026

The five historical provider failures were reproduced and diagnosed rather than
waived. They do **not** require real bearer tokens: two synthetic fixtures wrote
unprotected `auth.json` files, while three relied on `OPENCODE_AUTH_CONTENT`, an
upstream injection path absent from the protected BharatCode store. The fixtures
now acquire and restore their synthetic provider credentials through the real
Auth service. The old raw-file writer and environment-injection helpers were
removed. No production auth permissions, provider eligibility, networking or
error behavior changed. Full provider suite: **718/718, 1,672 assertions**;
OpenCode typecheck passes. Auth regression suite: **46 pass, 19 platform/fixture
skips, 0 fail, 388 assertions**; skips are not counted as Linux passes. Logs:
`/tmp/bc-provider-auth-regression.log`, `/tmp/bc-final-provider-suite.log` (RED),
`/tmp/bc-final-provider-green.log`, `/tmp/bc-provider-fixture-typecheck.log`.
A separate compiled fresh-home Linux Auth publication check also passed.

Clean Linux CLI/Node/Electron and AppImage/deb construction passed at exact
`c37f07d772315d5eefc9a8b3bd0cab29716851db`, with publication disabled. Debian
extraction confirms version 1.15.35, embedded source identity, and identical
CLI/app.asar bytes versus the unpacked builder output. Artifact SHA-256:

- AppImage: `3075467f4c7812032184f0e01d157b6c7ee11fedde39620f860fe679073c5c27`
- deb: `b1db46d9a96cc4d9b2c819480252bfee2c9ef15c0757f0c744a30a1d9b702276`
- bundled CLI: `31439647a8cec81dade04a571de482a2ef4a96638624719e7b74819a6bc954b8`
- app.asar: `57e43fa54079dfa25c8b2d8b087b890e4b7f9fde87e43d5e0b333809d6532b00`

Evidence: `/tmp/bc-final-{prebuild,electron,linux-package}.log` and
`/tmp/bc-final-linux-inspection.json`. These artifacts precede the subsequent
test-only fixture correction, and are not a completed cross-platform cohort.
No installation, launch, protocol registration or publication was performed.

### Desktop suite and CI inclusion — September 23, 2026

The former Desktop suite failure was reproduced: Bun 1.3.14 cannot import
`node:sqlite`, which is the production Electron/Node binding. The existing draft
test now bundles the unchanged store and executes it in an isolated Node child.
It retains the original latest-buffer/flush/blob assertions and consolidates the
separate disk-reopen smoke, adding unreferenced-blob cleanup and persisted deletion.
No database mock, runtime binding replacement or skipped assertion was introduced.
The duplicated draft smoke was removed from the separate compiled-sidecar suite.

Desktop previously had no package test command or Turbo test task. Both are now
present, so the normal CI test graph includes `bun test src`. A dry graph confirms
that exact command. Full Desktop source suite: **140/140, 449 Bun assertions**,
plus child Node assertions; Desktop typecheck passes. Separate compiled-sidecar
and SDK smoke: **2/2, 7 assertions**. Logs: `/tmp/bc-desktop-full-audit.log`
(RED), `/tmp/bc-desktop-full-green.log` and `/tmp/bc-desktop-task-graph.json`.
This closes the previously documented Bun/Node Desktop test mismatch; it does
not certify installed Electron or the remaining provider-auth-dependent suites.

### Native Windows storage/recovery refresh — September 23, 2026

Fresh Windows execution verifies credential ACL rejection, no-follow/link and
held-object protections, before/after-publication failures, fail-closed timeout,
compiled Auth create/read/rotate/logout across processes, ordinary inherited
first-use paths through both Global and migration initialization, and interrupted
capture/Start Fresh/partial-role activation retry. Across the targeted runs:
**31 tests pass** (17 credential, 2 first-use, 12 recovery), plus the compiled
Node capability fixture's **14 checks**. This is native isolated fixture evidence,
not installed-package or hardware power-loss certification.

Two harness problems were kept distinct from product failures. Bundling the
recovery suite turns exports into accessors unsupported by Bun's `spyOn`; all
12 tests pass using byte-identical staged source modules and their dependency.
The old compiled Auth test inherited the host environment despite supplying a
synthetic service layer. Core Global initialization happens at import time, so
its first attempt failed on default-directory permission validation before the
fixture action. That attempt was not properly profile-isolated and is not
claimed as synthetic acceptance. The test now gives its child only explicit
synthetic HOME/AppData/temp paths plus the required Windows system root; the
seven-process lifecycle then passes. No app installation, protocol registration,
OAuth flow or deliberate real-profile repair was performed.

Reproduction sources remain the existing Windows store/first-use and native
recovery suites plus `packages/core/test/fixture/capabilities-native.ts`.
The staging helper is `/tmp/bc-native-source-stage.cjs`; it copies only the
required modules into a new Windows temporary root and validates cleanup scope.

### Retained CI surface — September 23, 2026

Removed eight workflows whose products were already pruned from this re-fork:
VS Code/GitHub Action publishing and Action release, containers, SST deployment,
website documentation update/translation, and Storybook. None of their target
directories/configuration exists in this tree. Historical changelog classification
is retained because it intentionally reads old commits.

Unit/E2E/typecheck jobs now use standard Ubuntu 24.04 and Windows 2022 runners,
not the upstream-only Blacksmith runner labels. Playwright's pinned Node version
is selected after setup-bun, so the composite action cannot overwrite it.
Generated-client CI is now a read-only drift check of both SDK generations,
with isolated runtime directories; it no longer commits/pushes changes through
an upstream app credential. This does not alter candidate signing, source
admission, artifact policy or grant publication authority. Repository moderation
bots are outside this build/release cleanup and have not been enabled or run.

Evidence: retained build workflows parse as YAML and their local action/workdir
references exist; changed YAML passes formatting; both generators ran with zero
generated diff; candidate/packaging regressions **9/9, 52 assertions**. No hosted
workflow was dispatched and hosted runner execution remains unverified.

### Renderer SDK / compiled sidecar compatibility — September 23, 2026

The App's vendored `@opencode-ai/client` is an intentional transitional client,
not a drop-in alias for the newer workspace client. The bundled server exposes
both health routes and the renderer deliberately chooses the V1 compatibility
adapter. Replacing the tarball based only on its version would break the
`/promise` import and API contract. Production legacy clients use
`throwOnError: true`, so failed HTTP requests are not silently accepted by the
adapter. Both SDK generators were rerun with **zero generated diff**.

A new loopback-only test bundles the real renderer SDK factories and adapter,
then calls the compiled Node sidecar in two independent processes with a fresh
private home/project. It checks protocol selection, health, project identity,
session create/rename/list/read, file listing, untracked Git status, worktree
listing, wrong-credential rejection, persistence after process exit, and delete
followed by not-found. It makes no provider request or OAuth call; external fetch
is prohibited. The fixture is included in App typechecking. The first expanded
test exposed an incorrect fixture field (`path` versus VCS `file`), not a
production defect. Inactive commented compatibility stubs/tests were removed.

Evidence: focused adapter/protocol **11/11, 20 assertions**; compiled Node SDK,
account/migration and SQLite draft fixtures **3/3, 10 Bun assertions** plus the
child-process assertions; App/Desktop typechecks pass. Logs:
`/tmp/bc-sdk-{runtime-expanded,regeneration,app-typecheck,desktop-typecheck}.log`
and `/tmp/bc-client-regeneration.log`. This is compiled Linux/Node evidence, not
installed Windows/macOS, authenticated generation, or pure-V2-server acceptance.

### Renderer and native asset identity — September 23, 2026

The audit found upstream identity still visible in settings, recovery/native
menus, feedback destinations, splash/wordmark and native installer/dock icons.
The App dictionary now brands an explicit allowlist of product-owned messages,
preserving translated grammar/placeholders and native positional arrays. It
does not rewrite OpenCode Zen/provider identity, configuration paths or upstream
technical documentation. Native English fallback uses the same transformation.
Windows menu headings now use the typed translated label instead of literal text.

Both help/error feedback actions use the BharatCode issue tracker. Release
highlights use the prior BharatCode changelog URL; live availability is not
claimed. The accepted BharatCode SVG components and native icon assets are
reused from the preserved release line. Browser titles, favicon/manifest and
notification icons no longer present/fetch upstream branding. Unbranded
raster/social fallbacks were removed from the application HTML, and the unused
upstream Linux desktop launcher was deleted. App package/lockfile version now
matches the committed Desktop/CLI 1.15.35 rather than displaying upstream 1.18.31.

Evidence: missing-helper RED; native/product tests **11/11, 469 assertions**;
full App **744/744, 3,087 assertions**; browser-component suite **55/55,
170 assertions**; App, Desktop and UI typechecks and production App build pass.
Rendered loopback-only fixtures pass in both settings layouts, including
BharatCode page/footer identity and unchanged marketplace mutation/reload
behavior. The Impeccable refinement pass preserved layout and components; no
visual redesign or translation invention was introduced.

This remains rendered browser/isolated build evidence, not real sign-in or
installed native icon acceptance. Screenshots are
`/tmp/bc-marketplace-{legacy,new}.png`; logs are `/tmp/bc-brand-*.log`.

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

The 5 provider failures were present in that baseline. The original explanation
that they required real bearer tokens was incorrect: the current fixture audit
above identifies unsafe file fixtures and unsupported environment injection and
closes all five without real credentials or a production relaxation.

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

This is the current checklist; earlier checkpoint paragraphs describe evidence
and limits at the time they were recorded, not a second active backlog.

- **Final retained-feature audit:** reconcile the old release feature inventory
  with the implemented CLI, account, Goal Mode, marketplace, dictation, renderer,
  WSL and release changes. Goal routing/ribbon and SDK generation are implemented;
  do not restart those themes from the original re-fork backlog.
- **Fresh exact-source packages:** rebuild after the latest branding/runtime/CI
  commits. The earlier Linux packages and WSL runtime are intermediate evidence,
  not final-cohort artifacts. Verify Windows package contents and isolated native
  startup/upgrade/reopen paths; macOS signing/notarization requires a macOS host.
- **WSL/native boundaries:** exercise the same-source runtime lifecycle and
  account/error behavior without copying real credentials. Source/unit checks do
  not replace actual native-to-WSL execution evidence. The exact `5d20fa1450`
  native lifecycle passed; repeat against the final candidate after later fixes.
- **Broad test closure:** rerun affected suites at final source. Provider fixture
  failures and Bun-versus-Node draft-test differences are resolved, not waived.
  Keep compiled Node and native fixture results separate from installed Electron.
- **Acceptance limits:** real microphone/OAuth/model generation and signed-in
  installed UI are not established by mocked renderer or signed-out fixtures.
  No live-profile/install/publication action is authorized by these local checks.
- **Release handoff:** document the exact source/artifact cohort and the remaining
  external gates. Candidate construction is read-only/manual; it does not publish
  npm packages, promote updater metadata or deploy website changes.

The two original shell/review-pane fixes remain deliberately unported because
upstream already fixed them. The vendored renderer client is retained for its
transitional contract, with real bundled-V1 adapter verification; external pure-V2
Goal execution is not implied by that result.

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
