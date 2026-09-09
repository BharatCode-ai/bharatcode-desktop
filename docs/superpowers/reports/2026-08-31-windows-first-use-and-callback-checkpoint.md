# Windows first-use and callback privacy checkpoint

## Immutable source and scope

Candidate source: `b7b443b61b19fc62477fd22beffebbb9d9c13583` on
`codex/windows-recovery-actions`. Its parent is callback-privacy correction
`425faa17f6ce5de49bc41ac513d207aa0b72719f`, whose parent is browser-handoff
correction `36e1b1a35d5534766b1f9fac3e7f179be391e5a6`.

The privacy correction removes payload/error-object logging from second-instance,
open-url and queued forwarding. Tests inspect emitted logs with synthetic
code/state/token/fragment values, errors and duplicates. It does not change
callback routing, PKCE or state validation, and is not whole-app log certification.

The first-use correction reuses the existing native credential bridge in Core.
Its read/publication/ACL policy is unchanged. `prepareParent` privately creates
absent owned directories; existing ACLs remain untouched. Global initialization
and migration maintenance prepare the credential parent before ordinary directory
creation. Sidecar initialization invokes that owner after the main recovery gate
and before logging, database migration or listening. POSIX behavior is unchanged.

The direct parent/leaf policy still rejects unrelated effective principals.
Existing broad credential parents are **not repaired** by this correction.
Newly owned directories use the established current-user/SYSTEM creation policy;
the adapter's documented trusted-OS-principal boundary remains unchanged.

## Fresh execution evidence

All mutation tests below use newly created synthetic homes, never the user's
installed profile or actual OAuth data.

| Gate                                                      | Result                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| Callback logger RED then GREEN                            | Original logging failed 6 tests; corrected 7/7, 35 assertions        |
| Native callback/account/browser focused                   | 20/20, 71 assertions                                                 |
| Ordinary inherited first-use compiled fixtures            | Both Global/migration paths RED before fix; GREEN 2/2, 24 assertions |
| Native adapter plus compiled first-use                    | 19/19, 100 assertions                                                |
| Native recovery/cutover/journal scoped                    | 35/35, 133 assertions                                                |
| Linux Auth/migration/Product with Node 22.18.0            | 157 pass, 5 Windows-only skips, 0 fail, 824 assertions               |
| Linux Desktop suite                                       | 160/160, 759 assertions                                              |
| Linux Core global/storage-path tests                      | 5/5, 12 assertions                                                   |
| Native Core/OpenCode/Desktop package typechecks           | Pass                                                                 |
| Formatting and committed whitespace                       | Pass                                                                 |
| Windows production build and exact-source WSL build       | Pass; WSL reports 1.15.22                                            |
| Exact packaged CLI recovery                               | 3/3, 35 assertions                                                   |
| Exact packaged recovery then sidecar credential lifecycle | Create and process-restart/replacement/logout pass                   |
| Local unsigned NSIS installer build                       | Pass; not executed                                                   |

The first-use compiled fixtures create only ordinary OS-like AppData parents,
not a pre-hardened application credential directory. Six processes per owner
exercise creation, reread, transaction replacement, reread, logout and reread.

The local packaged harness runs the actual packaged recovery CLI's Start Fresh
only in a new synthetic home. It then loads the actual app.asar sidecar under the
packaged Electron Node runtime, with a test parent-port driver and loopback-only
fetch boundary. Production sidecar/auth endpoints create and replace synthetic
credentials; the same-source compiled Auth reader checks retained generations.
A separate sidecar process reuses the home, verifies persistence, removes the
credentials and observes signed-out status. No app main entry point, protocol
registration, browser flow or production API is invoked by this harness.

Important RED specificity: the prior 36e1 package passed a sidecar-only credential
fixture. It failed credential creation when the packaged recovery flow ran first.
The corrected b7b443 package passes that same recovery-first sequence. This
distinguishes the directory-owner ordering defect from the adapter-only tests.

## Non-green checks and limits

- The first Linux broad run used system Node 12.22.9; the locally packed launcher
  failed parsing `??`. The fresh run above used the existing Node 22.18.0 binary
  and passed. No source compatibility workaround was made.
- The broad native migration directory run was 77 pass, 3 skip, **5 fail**.
  Failures were Unix mode assertions/Linux-Darwin mode fixtures on Windows and a
  Windows symlink-removal fixture error. This is not reported as a green full
  native migration suite. The scoped native and packaged gates above passed.
- Linux typechecking remains unavailable because the shared cache lacks the
  Linux native-preview executable. Native package typechecks are the fresh
  successful type evidence; no unrelated cache mutation was made.
- Native API/interruption tests are not hardware power-loss certification.
  Privileged wrong-owner mutation and full OS security are not claimed tested.
- Packaged synthetic credentials are not real OAuth/refresh-server acceptance.
  Normal installed visible UI, callback recipient, original PKCE/state,
  authenticated restart and test-account logout still require the separately
  approved disposable-account test.

## Packaged identities and replayable local evidence

Version `1.15.22`, channel `beta`, source b7b443 above:

Preserved unsigned local NSIS installer: `221035869` bytes, SHA-256
`4e7cc6700222d00cef659f2ed1a0028e4967086eaab27c251b1ed557c828dfb8`.
Its absolute path and approval-bound procedure are in
[the disposable-account acceptance guide](2026-08-31-disposable-windows-oauth-acceptance.md).

| Component                      | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| app.asar                       | `562367e2e03e7a7e4745f231b82bde5518798b6c528354799b9d6bfbd51183f0` |
| Packaged recovery CLI          | `dfb644578c293824297ace65169457fc84dc047fe8308a74805700f5bcb7229b` |
| WSL runtime, 129362048 bytes   | `f99fd154753991a304626998d33be7bb27afa4846f8279f5bf310d0d615a5ae5` |
| Compiled synthetic Auth reader | `aba3cb4c066a89848dbfc18eb63da331437a0096eb51ee448eb9ac75104bd3a4` |

Native source/build root is
`C:\Users\Shrey Gupta\AppData\Local\Temp\bharatcode-hotfix-source-72202f0c`.
Its indexed tree was matched to the immutable WSL source before building.
Package root is `packages\desktop\dist\win-unpacked` beneath that directory.

Retained local harnesses under `C:\Users\Shrey Gupta\AppData\Local\Temp`:

- `bc-packaged-first-use.mjs`, SHA-256
  `17174a11a4cbb2ca74c825eaa4badf7b3905013618da694a1e1b6581a71fc81e`.
- `bc-packaged-first-use-host.mjs`, SHA-256
  `da9dcd8c3a8bb462daf535d3528e8ddd12bbce98cd5ebad61a985bd24f8c68db`.
- `bc-native-first-use.exe` is the compiled committed synthetic fixture.

Logs there: `bc-packaged-first-use-red.log`,
`bc-packaged-first-use-b7b443.log`, `bc-recovery-b7b443-installed.log`,
`bc-recovery-b7b443-build.log`, `bc-recovery-b7b443-package.log`,
`bc-recovery-b7b443-nsis.log`, and
`bc-first-use-native-recovery-scoped.log`.
WSL broad-suite log: `/tmp/bc-first-use-posix-node22.log`.

## Remaining authority boundary

No installer was executed, account created, protocol association changed, real
callback consumed/replayed, real credential/profile migrated/reset, or existing
ACL edited during this checkpoint. Only the owned isolated diagnostic app was
stopped to rebuild its output; the user's old installed app was left untouched.

The observed browser return to an older installed EXE remains evidence of an
incorrect callback recipient, not proof of the mechanism that selected it.
Random per-launch test profiles are unsuitable for authoritative OAuth testing.
Use the companion disposable-account procedure after explicit user approval.
Website downloads, replacement recommendation, publication and formal JIT/WSL
release acceptance remain HOLD.
