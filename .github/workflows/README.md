# BharatCode Desktop workflows

The release flow is build candidates, manually test them on Windows/Linux/macOS,
then explicitly publish the exact accepted artifacts without rebuilding. Candidate
builds run no test suites. Source identity, artifact integrity and macOS signing/
notarization checks remain part of packaging and publication.

The following diagnostic workflows are manual-only and are not release gates:

- `test.yml`: Linux/Windows unit and renderer E2E checks, generated-client checks,
  and the Linux HTTP route exerciser. Read-only repository permissions.
- `typecheck.yml`: workspace typechecks. Read-only repository permissions.
- `generate.yml`: verify generated client output without pushing changes.

The build and publication workflows are separate from those diagnostics:

- `publish.yml`: manually build an exact-source Desktop candidate for Windows,
  macOS arm64/x64, Linux and the bundled WSL runtime. Upload artifacts only.
- `build-and-publish.yml`: manually build all CLI targets on one Linux runner.
  A separate explicit `publish-tested` operation verifies the existing tarballs
  before npm/GitHub publication, without rebuilding or overwriting.
- `bharatcode-publish-tested-candidate.yml`: manually publish an already accepted
  exact Desktop cohort. Verify producer identity, manifests and downloaded bytes;
  begin as a draft and require immutable publication. Optional website notification
  happens only after public download checks. No automatic npm/Homebrew mutation.

Candidate construction does not imply publication or installed acceptance.
Publication requires explicit operator approval, the exact tested source/run and
artifact hash, and the configured release environment. Preserve the existing
`build-and-publish.yml` filename for npm trusted-publisher configuration.

Windows/Linux beta packages are unsigned by policy. Both macOS architectures
require Developer ID signing, notarization and stapling. No unsigned macOS
fallback is allowed. The historical JIT/Hyper-V and version-pinned release
harnesses are not reinstated by this catch-up.

Upstream issue/PR bots, compliance closing, stats, Discord notifications and SST
infrastructure operations remain removed, as established by `d40bcb9230` on the
BharatCode release lineage. They are not runtime features and must not be
reactivated by importing upstream workflow files. Do not add upstream API keys,
deployment credentials, or issue-writing permissions to make them run.
