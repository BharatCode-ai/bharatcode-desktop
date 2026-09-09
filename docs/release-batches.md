# Desktop releases: four steps

This is the active release process, replacing the historical mandatory JIT,
Hyper-V, automated upgrade/rollback, and custom acceptance-receipt orchestration.
Historical reports remain historical; they do not impose extra gates on a new batch.

## 1. Accumulate fixes locally

Commit fixes without building or releasing after each edit. Run relevant existing
tests/typechecks. Before freezing the batch, run the broader applicable package
suites once and record real failures separately from broken test infrastructure.
Do not call a skipped or unavailable check PASS. No new contract/evidence program
is required for ordinary fixes.

## 2. Freeze one candidate and build once

- Confirm the worktree is clean and Desktop/CLI package versions agree. Choose
  the version once for the batch; never reuse an already published version/tag.
- Record the exact source SHA, then dispatch **BharatCode build release candidate**
  at a ref pointing to that SHA, supplying the same `source_sha`.
- The workflow builds Windows x64 NSIS (unsigned), macOS arm64 and x64 ZIPs
  (Developer ID signed/notarized/stapled), Linux x64 AppImage/deb (unsigned),
  CLI tarballs, and the same-source bundled WSL runtime.
- Download `desktop-candidate-<run-id>`. Record the archive SHA-256 from the run
  summary and verify it locally. The archive contains `release-manifest.json`,
  `SHA256SUMS`, the installable files, and updater files. Keep this exact archive.
- A transient job failure: rerun failed jobs only. Successful producer artifacts
  have stable same-run names and are reused. Uploads refuse overwrite. If a failed
  job already uploaded an artifact, investigate instead of replacing it silently.
- A source/build-input correction requires a new frozen SHA/run. Do not mix files
  across runs or pretend rebuilt files received the earlier manual acceptance.

## 3. Test those packages manually

Record the source SHA, build run, archive SHA-256, tester, date, OS/architecture,
and results in a short release note/issue. Test actual packages, not a patched
app.asar or a development server. Keep a previous installer and a private backup
before upgrade testing; do not use destructive test harnesses on a daily profile.

| Check                        | Record for each applicable platform                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Fresh launch                 | Install/extract, launch, complete first use without a recovery loop                    |
| Upgrade                      | Install over the previous version; account and conversations survive                   |
| Account                      | Sign in and return to the correct installed application                                |
| Coding                       | Open a project, load models, send one real request, inspect its response               |
| Persistence                  | Close and reopen; account, project, and selected conversation return                   |
| Platform behavior            | macOS launch/notarization, Linux packaging, Windows protocol handler ownership         |
| WSL                          | On Windows, select a distro, open a WSL project, verify runtime location and reconnect |
| Downloads/rollback readiness | Keep the previous installer, known hashes, and data backup; record limitations         |

Use PASS, FAIL, or NOT TESTED with a brief note. A missing platform or broken
harness is NOT TESTED, not a product failure. Any accepted limitation needs the
owner's explicit approval in the notes. Data loss, security defects, broken
startup, invalid signing, mismatched artifacts, or an unusable package block
publication. Manual acceptance is never described as an automated WSL/upgrade PASS.

## 4. Publish the verified files, then check the website

- Dispatch **BharatCode publish tested candidate** from the repository default
  branch. Supply the frozen SHA, successful build run ID, recorded archive SHA-256,
  manual confirmation, and acceptance notes. The existing release environment
  approval remains in place. This workflow has no build/install/test step.
- It verifies the downloaded archive and source provenance, rehashes all files,
  creates a new draft, uploads without overwrite, verifies remote hashes, and
  finalizes the immutable prerelease. A partial upload stays draft: investigate
  or abandon it explicitly; no automatic destructive cleanup or resume-overwrite.
- Verify public asset URLs before optionally notifying the website. Then confirm
  Windows/macOS/Linux buttons, labels, versions, and redirects on the live site.
  A failed website update can be retried separately without rebuilding packages.
- npm/Homebrew publication, if needed for this batch, is a separate explicit
  action using the already verified outputs/version, not another Desktop build.
- If a published defect is found, contain the affected download and prepare a
  new version. Never overwrite published files or automatically downgrade a live
  database. Preserve schema/data and choose rollback only after compatibility review.

## What is no longer mandatory

No ephemeral Hyper-V host, custom JIT runner, upgrade/rollback automation,
version-specific owner-waiver receipts, acceptance notary, or full-CI rerun per
small fix. Historical helper scripts are retained for reference, not invoked by
the active release workflows. Old per-platform publication workflows are archived
so publishing does not trigger another build.
