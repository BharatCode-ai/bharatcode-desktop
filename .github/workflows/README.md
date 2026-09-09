# BharatCode Desktop release workflows

The BharatCode Desktop repository uses two manually dispatched workflows:

1. `bharatcode-next-beta-candidate.yml`: build one frozen source into Windows,
   macOS arm64/x64, Linux AppImage/deb, CLI packages, and the bundled WSL runtime.
   Upload the hashed candidate for manual testing. No publication authority.
2. `bharatcode-publish-tested-candidate.yml`: after manual acceptance, download
   that exact run's candidate, verify its archive hash, GitHub provenance, and
   package hashes, then publish without rebuilding or overwriting. Website
   notification is optional and occurs only after public download checks pass.

Follow [the four-step checklist](../../docs/release-batches.md).

The previous `bharatcode-desktop-linux.yml`, `bharatcode-desktop-macos.yml`,
`bharatcode-desktop-windows.yml`, and preliminary WSL workflow are archived under
`../retired-workflows/` as text. They must not rebuild/upload on release events.
The historical JIT/Hyper-V and upgrade/rollback harnesses are not release gates.
Their version-pinned candidate/workflow assertions are retired as text too;
ordinary runtime, migration, account, and package tests remain available.

Signing policy: Windows/Linux unsigned beta; both macOS architectures Developer
ID signed, notarized, and stapled. Keep existing Apple secrets and the expected
Developer ID repository variable configured. There is no unsigned macOS fallback.
Publication retains the existing `desktop-beta-release` environment and requires
GitHub release immutability. No npm publish or Homebrew mutation is automatic.
