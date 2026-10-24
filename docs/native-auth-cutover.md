# Native Auth release preparation

Status: **branch push and build-only CI approved; no publication or production activation approved**.
This repository is the Desktop/CLI repository, not the API/Web repository.
Use the API/Web `infra/auth/README.md` as the migration operator runbook. This
document owns only the native release and installed-client acceptance gates.

## Compatibility boundary

- The staged native default is `https://auth.bharatcode.ai/auth/v1`. Do not publish
  this candidate, promote updater metadata or change an npm tag while production
  API issuer trust and the central Auth/login UI still use the hosted authority.
  Merely setting an environment variable during a build does **not** bake a
  different Auth default into the binaries: these are runtime overrides.
- `BHARATCODE_AUTH_URL` wins over `OPENCODE_AUTH_URL`; an explicitly invalid value
  fails closed. Either selects **one** issuer, never adds another accepted issuer.
  The same policy drives Desktop's browser allowlist, the native service and the
  explicit endpoint forwarded into the sanitized WSL environment. No discovery,
  fallback, mixed-authority acceptance or token-based endpoint selection is added.
- Preserve public native OAuth client ID `4cad332a-232f-4ef2-9363-12fea4420635`,
  S256 PKCE and exact registered callbacks `bharatcode://auth/callback` and
  `http://127.0.0.1:27182/callback`. Do not add a native client secret.
- Keep app IDs, `bharatcode` protocol registration, storage paths, auth-store
  format, API URL `https://bharatcode.ai/api/model/v1`, API keys, saved projects and
  chats unchanged. Do not reset/import credentials or invoke migrations as an
  Auth update workaround. Windows credential-store protections remain in place.
- Recognizable stored JWTs from another issuer require fresh sign-in **before**
  sending access or refresh credentials anywhere. Their stored bytes remain
  intact until an explicit successful replacement/logout. This local issuer
  parsing is a routing guard, not cryptographic JWT verification. Identity comes
  from the selected authority's UserInfo; API authorization remains server-side.
- Existing API-key records are not rewritten. The shipped native product already
  uses OAuth for its account/model path; preserving a key is not a claim that the
  shipped account UI gains API-key login. Independently test existing API-key
  clients against the API during the coordinated cutover.
- The reviewed pre-migration native base (`1e97842919d87a350b38ea5fcf55f952af072e2e`)
  hardcodes the hosted issuer in the CLI account service and Desktop browser
  allowlist, and its sanitized WSL environment does not forward an Auth override.
  Neither `BHARATCODE_AUTH_URL` nor `OPENCODE_AUTH_URL` retargets that account
  path. Those binaries need an approved update and a new sign-in after issuer
  retirement, not just an environment change. Other installed versions were not
  inventoried; do not promise an override without checking their exact source.
  The staged candidate supports the exclusive overrides described above. Do not
  accept old tokens to hide the update requirement or retry a model stream under
  a different account.

## Local verification

Run commands from the named package, not the repository root. All Auth fixtures
are synthetic and temporary. Never use real profiles, API keys or production
provider credentials for automated tests.

```sh
# packages/core
bun test test/bharatcode-auth.test.ts
bun typecheck

# packages/opencode
bun test test/bharatcode/account.test.ts test/bharatcode/account-http.test.ts \
  test/bharatcode/loopback.test.ts test/server/httpapi-account.test.ts \
  test/bharatcode/runtime.test.ts --timeout 30000
bun test test/auth/auth.test.ts --timeout 30000
bun typecheck

# packages/desktop
bun test src/main/bharatcode-auth.test.ts src/main/sidecar-auth.test.ts \
  src/main/sidecar-authorizations.test.ts src/main/wsl/transport.test.ts \
  src/main/wsl/artifact.test.ts src/main/deep-link-events.test.ts \
  src/main/branding.test.ts scripts/tested-release.test.ts \
  scripts/candidate-cohort.test.ts electron-builder.config.test.ts
bun typecheck
```

The existing `packages/opencode/script/auth-local-exercise.ts` and
`packages/desktop/scripts/auth-desktop-exercise.ts` exercise real synthetic Auth
fixtures. They intentionally refuse a production hostname. The Desktop harness
is Linux development Electron, **not installed Windows acceptance**. Earlier
rehearsal receipts must not be represented as a new run on later edits.

An offline local Node-sidecar bundling check uses the existing builder:

```sh
# packages/opencode; diagnostic build, not a release candidate
MODELS_DEV_API_JSON=test/tool/fixtures/models-api.json BHARATCODE_CHANNEL=dev \
  bun script/build-node.ts
```

This uses a synthetic model snapshot to avoid an external models.dev fetch; it
is not a production catalog check, installer, or signed/accepted release.

## Exact Windows-only test-build plan

### Additional runtime evidence (2026-10-24)

The local native-only followup rebuilt the development Electron output using
the cached toolchain and the exact previously built Node sidecar bundle. It
reused the real synthetic GoTrue v2.197.0/PostgreSQL rehearsal under separate
container names, loopback ports, disposable credentials and profiles; no
production accounts, external providers or model requests were used.

- Real CLI entrypoint (`src/index.ts auth ...` under Bun): PKCE/loopback login,
  wrong-state rejection, UserInfo/persistence, fresh-process status, forced
  refresh rotation, exclusive issuer mismatch rejection without credential
  deletion, legacy override and logout with an unrelated synthetic API key kept.
- Real Linux development Electron: rendered window, preload/IPC, main process,
  bundled utility-process sidecar, custom callback via actual second-instance
  delivery, forced-expiry refresh rotation and local logout all passed.
- Browser consent was driven by the existing synthetic consent helper. CLI's
  Windows browser executable was suppressed inside a child mount namespace;
  Desktop's external-browser dispatch used its existing local capture driver.
  Neither touched the installed browser profile or OS protocol registry.
- These are runtime/development-package checks, not signed installed acceptance.
  Cold/warm OS protocol association, upgrade preservation, Windows credential
  ACLs, real provider consent and exact eventual installer bytes still require
  owner acceptance. Windows beta is explicitly unsigned under existing policy;
  do not claim a signed Windows artifact where none exists.

The distinct aggregate receipt is under
`/home/ubuntu/bharatcode/.git/auth-final-checks-20261024/`.
The machine-specific fixture wrapper and CLI runtime driver remain local
rehearsal helpers, not shipped repository dependencies. Reuse the committed
Desktop and shared-service exercises only with fresh synthetic fixtures. The
local fixture wrapper uses cached Docker images with `--pull=never`; its bridge has
outbound masquerading disabled and publishes loopback ports only. It is not a
claim of an audited network sandbox.

### Build-only CI candidate

Version 1.15.43 is an unpublished test candidate. Run the existing Desktop
`publish.yml` workflow with the exact committed `source_sha` and `channel=beta`.
Despite its filename, this workflow only builds and uploads GitHub Actions
artifacts; every packager uses `--publish never`. The CLI workflow may run only
with `operation=build` and publication inputs left false. Do not dispatch the
tested-candidate publisher or promote any release, npm tag or updater metadata.

Before the coordinated cutover, the new Auth endpoint is restricted staging,
not a public native OAuth service. For ordinary Windows compatibility testing,
fully quit BharatCode, then launch this candidate with the process-only runtime
override `BHARATCODE_AUTH_URL=https://evgvlcaxfpwupaiwzqqm.supabase.co`.
This tests the candidate against the still-live hosted authority without
changing production. It does not pass the first-party installed-login gate.
Do not persist that override in Windows settings or package it in a release.

### Optional local Windows packaging

No new build workflow is needed. Reuse the existing builders below after an
approved commit/version and a clean checkout. Keep CLI/Desktop versions equal;
do not reuse an already published version. Use the same source SHA on Linux and Windows, native
dependencies on each OS, Bun from `packageManager`, and the existing Windows C++
toolchain. Do not reuse Linux `node_modules` from a UNC path on Windows.

For this machine, defer packaging until the Windows backing drive has at least
12 GiB free (a conservative local headroom gate, not a measured package size).
The initial check had about 7 GiB free; WSL's reported free space is **not**
additional physical headroom on that drive. Do not delete projects or bypass
clean-source/same-source artifact checks to make the build fit.

1. In a clean Linux x64 checkout of the approved source, install the frozen
   dependencies, select `beta`, and build only the required bundled WSL runtime:

   ```sh
   bun install --frozen-lockfile
   export BHARATCODE_SOURCE_SHA="$(git rev-parse HEAD)"
   export BHARATCODE_CHANNEL=beta
   test -z "$(git status --porcelain --untracked-files=normal)"
   cd packages/opencode
   bun script/build.ts --single --skip-install --skip-embed-web-ui --wsl-candidate
   ```

   Preserve `dist/wsl-runtime-x64/bharatcode-runtime-linux-x64-glibc` and its
   `manifest.json` byte-for-byte in a read-only transfer directory. This is one
   Linux dependency for Windows, not a Linux Desktop/all-platform build.

2. In a separate clean native Windows checkout of **that same SHA**, after
   `bun install --frozen-lockfile`, verify both transferred files are regular,
   non-reparse files and set their read-only attribute. In PowerShell, supply
   their actual absolute paths below; do not substitute an older runtime:

   ```powershell
   $env:BHARATCODE_SOURCE_SHA = (git rev-parse HEAD).Trim()
   $env:BHARATCODE_CHANNEL = 'beta'
   $env:BHARATCODE_WSL_RUNTIME = 'C:\auth-candidate\wsl\bharatcode-runtime-linux-x64-glibc'
   $env:BHARATCODE_WSL_RUNTIME_MANIFEST = 'C:\auth-candidate\wsl\manifest.json'
   $env:BHARATCODE_WSL_RUNTIME_ARCH = 'x64'
   $env:BHARATCODE_ALLOW_UNSIGNED_WINDOWS = '1'
   $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
   if (git status --porcelain --untracked-files=normal) { throw 'Dirty source' }
   Set-Location packages/desktop
   bun scripts/prebuild.ts
   if ($LASTEXITCODE -ne 0) { throw 'Prebuild failed' }
   bun x electron-vite build
   if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
   bun x electron-builder --config electron-builder.config.ts --win --x64 --publish never
   if ($LASTEXITCODE -ne 0) { throw 'Windows package failed' }
   ```

   Expected outputs: `packages/desktop/dist/bharatcode-desktop-win-x64.exe` and
   `packages/opencode/dist/bharatcode-windows-x64/bin/bharatcode.exe`. Record size,
   SHA-256, source/tree/version/channel, tool versions and WSL manifest hash in a
   **local-only** receipt. Windows beta is unsigned under the existing explicit
   policy; don't label it signed. Do not upload its updater YAML or manufacture a
   CI producer identity to satisfy cohort publication.

3. Test those exact bytes. A local Windows test is not the full release cohort.
   Once build/push/CI are separately approved, existing `publish.yml` builds the
   Desktop cohort, `build-and-publish.yml` builds CLI candidates, and
   `bharatcode-publish-tested-candidate.yml` publishes only the accepted exact
   Desktop cohort. CLI publication uses its existing `publish-tested` operation.
   Only the build operations are currently approved. Do not rebuild after manual acceptance and call the
   new bytes tested.

## Installed-client gates before publication/cutover

- [ ] Windows upgrade from the current installed beta: projects/chats/config and
      credential permissions unchanged; correct product/channel and executable.
- [ ] Real OS `bharatcode://` handoff reaches the right installed process both
      already-running and cold-start; never another channel or an old app.
- [ ] Google/GitHub, and LinkedIn only once separately approved/verified: browser
      consent, callback, stable restored UUID, token refresh, restart and local
      logout. Provider-harness success alone does not pass native OAuth consent.
- [ ] CLI browser login on Windows uses port 27182, rejects wrong/replayed state,
      handles occupied port, refreshes across process restart and preserves keys.
- [ ] Native Windows and bundled WSL both use the selected issuer; test each
      supported override independently, account switching and rejected mixed
      authorities. No retained staging override in the final normal launch.
- [ ] Reauthentication after old-session retirement preserves identity, project
      and chat data. Old installed binaries' upgrade instructions are ready.
- [ ] Fresh OAuth model request and existing API-key request pass against the
      coordinated API; no real inference calls before explicit test approval.
- [ ] macOS/Linux installed callback, refresh, upgrade and logout acceptance on
      their eventual cohort artifacts; macOS signing/notarization unchanged.
- [ ] Owner approves publication and the coordinated issuer activation window.

Keep all provider/app secrets out of binaries, receipts, support logs and source.
Record aggregate outcomes only. Rollback is an authority-wide operator decision:
do not automatically restore hosted issuer trust or accept both authorities from
native clients after the target has received identity writes.
