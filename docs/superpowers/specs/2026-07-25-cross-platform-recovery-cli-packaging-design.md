# Cross-Platform Recovery CLI Packaging Design

## Objective

Every BharatCode Desktop package must contain the exact native BharatCode CLI
that startup recovery invokes before account initialization, sidecar startup,
or first-window creation.

The installed executable must be:

- `resources/bharatcode-opencode-cli.exe` on Windows;
- `Contents/Resources/bharatcode-opencode-cli` inside the macOS app; and
- `resources/bharatcode-opencode-cli` inside the unpacked Linux app.

Packaging must fail before producing a distributable artifact if that file is
missing, malformed, or not executable where the platform requires executable
permissions.

## Root Cause

Desktop startup recovery correctly resolves a fixed executable beneath
Electron's `process.resourcesPath`. Desktop prebuild currently compiles only
the embedded Node service through `packages/opencode/script/build-node.ts`.
It does not build or stage the full native CLI. The surviving sidecar-copy
helper has no caller, uses legacy artifact assumptions, and does not establish
the installed `process.resourcesPath` contract.

Consequently, the preliminary Windows installer passed its existing workflow
acceptance but could not reach its first packaged UI gate.

## Architecture

### Native CLI staging

A dedicated Desktop staging script will:

1. Build one native BharatCode CLI for the current host and architecture.
2. Use the baseline-compatible variant on x64 and the native variant on arm64.
3. Require exactly one matching CLI output.
4. Copy its exact bytes to the Desktop generated-resources location using the
   platform-specific executable suffix.
5. Preserve executable permissions on Unix.

The Desktop prebuild sequence will run the native CLI build before the Node
service build. This order is required because the native CLI build recreates
the OpenCode `dist` directory; running it second would delete the Node service.

The generated recovery executable remains ignored by Git and is never committed.

### Electron packaging

The shared Electron Builder configuration will copy the staged executable
through `extraResources` so the installed filename exactly matches
`bundledRecoveryExecutable(process.resourcesPath)`.

An `afterPack` verifier will resolve the real unpacked application layout for
Windows, macOS, and Linux and validate:

- the exact expected installed path exists as a regular file;
- Windows files have a PE signature;
- macOS files begin with the native 64-bit Mach-O signature
  (`cf fa ed fe`);
- Linux files have an ELF signature; and
- macOS and Linux files retain at least one executable bit.

The verifier runs before later signing or notarization steps. It introduces no
signing action and does not alter existing release signing policy.

### Target architecture

Current release jobs package each target on a matching native host:

- Windows x64 on Windows x64;
- macOS arm64 on macOS arm64;
- macOS x64 on macOS x64; and
- Linux x64 on Linux x64.

The staging contract therefore builds the host-native CLI. It does not add
cross-compilation or multi-architecture packaging machinery.

## Failure Handling

Staging fails closed when the native build returns no CLI or more than one
candidate. Packaging fails closed when the staged input is absent or the
installed output does not satisfy the platform format and permission contract.

These failures occur before publication and use path-only error messages. They
must not expose credentials, protocol callbacks, OAuth values, or user data.

## Verification

Automated tests will cover:

- platform-specific staged and installed filenames;
- exact byte copying from a single build output;
- rejection of missing and ambiguous build outputs;
- executable permissions on Unix;
- Windows, macOS, and Linux installed-layout resolution;
- PE, Mach-O, and ELF validation;
- packaging rejection for missing, malformed, or non-executable files;
- prebuild ordering that preserves the Node service; and
- unchanged startup-recovery command and installed-path composition.

Local verification will include the focused tests, complete Desktop tests,
Desktop and OpenCode typechecks, formatting, parser checks, source-scope scans,
and a native Linux build plus unpacked-package inspection. If a required Linux
packaging dependency is unavailable on the host, its exact dependency failure
will be reported rather than presented as package evidence. Windows-native
controller and packaged UI evidence remains owned by the separate Windows
proof.

## Preliminary Source Boundary

The product correction changes a protected packaging file. After the product
head is committed and verified, a separate two-line release commit will advance
the preliminary workflow's accepted WSL source SHA and its matching contract
test to that exact product head. The protected-path list remains unchanged.

## Non-Goals

This correction does not:

- change startup recovery behavior or renderer UI;
- add a fallback around recovery;
- sign Windows artifacts;
- run signing, notarization, ShareNext, production distribution, or the broad
  cohort;
- alter the final signed workflow; or
- authorize a second live preliminary run.
