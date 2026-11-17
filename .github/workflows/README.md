# BharatCode Desktop workflows

The release flow is build candidates, manually test them on Windows/Linux/macOS,
then explicitly publish the exact accepted artifacts without rebuilding. Automated
checks are not installed acceptance. Source identity, artifact integrity and macOS signing/
notarization checks remain part of packaging and publication.

The following diagnostic workflows are manual-only and are not release gates:

- `test.yml`: Linux/Windows unit and renderer E2E checks, generated-client checks,
  and the Linux HTTP route exerciser. Read-only repository permissions.
- `typecheck.yml`: workspace typechecks. Read-only repository permissions.
- `generate.yml`: verify generated client output without pushing changes.

The build and publication workflows are separate from those diagnostics:

- `publish.yml`: manually build an exact-source Desktop candidate for Windows,
  macOS arm64/x64, Linux and the bundled WSL runtime on the production (`prod`)
  channel. Explicitly acknowledge the unsigned Windows **test build**. Upload artifacts only.
  The default `target=all` builds the full cohort. `target=windows-x64` builds
  only the Windows test artifact and its same-source WSL runtime; no publishable
  cohort is assembled and publication completeness checks remain unchanged.
- `build-and-publish.yml`: manually build all CLI targets on one Linux runner.
  A separate explicit `publish-tested` operation verifies the existing tarballs
  before npm/GitHub publication, without rebuilding or overwriting.
- `bharatcode-publish-tested-candidate.yml`: manually publish an already accepted
  exact Desktop cohort from the protected default branch. Verify producer identity,
  receipts, manifests and bytes with default-branch tooling. Publish one immutable,
  non-prerelease `desktop-X.Y.Z` without changing the repository-wide latest alias.
  **Only for 1.15.48**, publish the immutable `desktop-beta-1.15.48` prerelease
  after verifying every stable asset by anonymous download. Its only assets are
  `beta.yml`, `beta-mac.yml` and `beta-linux.yml`, pointing to the canonical
  binaries. The website notification is opt-in and names only the canonical tag.
  No automatic npm/Homebrew mutation.

Candidate construction does not imply publication or installed acceptance.
Publication requires explicit operator approval, the exact tested source/run and
artifact hash, and the configured release environment. Preserve the existing
`build-and-publish.yml` filename for npm trusted-publisher configuration.

For the staged first-party Auth migration, also follow the
[native cutover gates](../../docs/native-auth-cutover.md). Its changed issuer
default must not be published ahead of the coordinated Auth/API activation.

Keep repository immutable releases enabled and retain the existing protected
`desktop-beta-release` environment, despite its historical name. On interruption,
rerun with the same source, producer run/attempt, cohort hash and acceptance notes:
matching drafts get only their missing assets; matching public releases are
reverified without edits. Unknown tags, foreign drafts, mismatched hashes or
failed-upload placeholders stop publication and require operator inspection.
Nothing is deleted or overwritten. Recover before the producer artifacts expire
(14 days); a new build is a different candidate and needs its own acceptance.
The old 1.15.46 resolver only looks at the first 100 GitHub releases: keep the
bridge discoverable during migration. The new updater paginates stable discovery.

Windows/Linux packages are unsigned. Stable publication additionally requires
explicit operator approval of the unsigned Windows installer; if signed Windows
is required, stop and change the signing **and** receipt policy before building.
Both macOS architectures
require Developer ID signing, notarization and stapling. No unsigned macOS
fallback is allowed. The historical JIT/Hyper-V and version-pinned release
harnesses are not reinstated by this catch-up.

Upstream issue/PR bots, compliance closing, stats, Discord notifications and SST
infrastructure operations remain removed, as established by `d40bcb9230` on the
BharatCode release lineage. They are not runtime features and must not be
reactivated by importing upstream workflow files. Do not add upstream API keys,
deployment credentials, or issue-writing permissions to make them run.
