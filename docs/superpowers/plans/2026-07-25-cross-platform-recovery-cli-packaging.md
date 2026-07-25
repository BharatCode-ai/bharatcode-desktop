# Cross-Platform Recovery CLI Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship exactly one native BharatCode recovery CLI at the installed `process.resourcesPath` location in every Windows, macOS, and Linux Desktop package, and fail packaging before publication when that contract is not met.

**Architecture:** A pure shared contract owns platform filenames and executable-header validation. A dedicated prebuild stage builds one host-native CLI, copies it into an ignored generated resource, and then allows the Node service build to run. Electron Builder excludes that generated CLI from `app.asar`, copies it once through `extraResources`, and verifies the real installed path in `afterPack`.

**Tech Stack:** TypeScript, Bun, Bun test, Electron Builder 26 hooks, PE/Mach-O/ELF header validation, existing BharatCode CLI build.

---

## Global Constraints

- Do not change startup recovery commands, UI, or fallback behavior.
- Do not add signing commands or run signing, notarization, ShareNext, production distribution, or the broad cohort.
- Do not commit generated recovery executables.
- Use the baseline-compatible CLI build on x64 and the native build on arm64.
- Do not package the recovery CLI inside `app.asar`; copy exactly one executable through `extraResources`.
- Keep the final signed workflow byte-identical.
- A new live Windows preliminary run requires separate authorization after local and native preflight verification.

### Task 1: Shared recovery CLI contract

**Files:**

- Create: `packages/desktop/scripts/recovery-cli-contract.ts`
- Create: `packages/desktop/scripts/recovery-cli-contract.test.ts`

- [ ] **Step 1: Write failing filename and executable-header tests**

Create `packages/desktop/scripts/recovery-cli-contract.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"

import { recoveryCliFilename, validateRecoveryCliHeader } from "./recovery-cli-contract"

describe("recovery CLI packaging contract", () => {
  test("uses the fixed installed filename on every desktop platform", () => {
    expect(recoveryCliFilename("win32")).toBe("bharatcode-opencode-cli.exe")
    expect(recoveryCliFilename("darwin")).toBe("bharatcode-opencode-cli")
    expect(recoveryCliFilename("linux")).toBe("bharatcode-opencode-cli")
    expect(() => recoveryCliFilename("aix")).toThrow("Unsupported recovery CLI platform")
  })

  test("accepts only the native executable header for each platform", () => {
    expect(() => validateRecoveryCliHeader("win32", Uint8Array.from([0x4d, 0x5a]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("darwin", Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("linux", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("win32", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).toThrow(
      "invalid Windows PE header",
    )
    expect(() => validateRecoveryCliHeader("darwin", Uint8Array.from([0x4d, 0x5a]))).toThrow(
      "invalid macOS Mach-O header",
    )
    expect(() => validateRecoveryCliHeader("linux", Uint8Array.from([0x4d, 0x5a]))).toThrow("invalid Linux ELF header")
  })
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
cd packages/desktop
bun test scripts/recovery-cli-contract.test.ts
```

Expected: FAIL because `./recovery-cli-contract` does not exist.

- [ ] **Step 3: Implement the minimal pure contract**

Create `packages/desktop/scripts/recovery-cli-contract.ts`:

```ts
export type RecoveryCliPlatform = "win32" | "darwin" | "linux"

export function requireRecoveryCliPlatform(value: string): RecoveryCliPlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value
  throw new Error(`Unsupported recovery CLI platform: ${value}`)
}

export function recoveryCliFilename(value: string) {
  return requireRecoveryCliPlatform(value) === "win32" ? "bharatcode-opencode-cli.exe" : "bharatcode-opencode-cli"
}

export function validateRecoveryCliHeader(value: string, bytes: Uint8Array) {
  const platform = requireRecoveryCliPlatform(value)
  const expected =
    platform === "win32" ? [0x4d, 0x5a] : platform === "darwin" ? [0xcf, 0xfa, 0xed, 0xfe] : [0x7f, 0x45, 0x4c, 0x46]
  if (expected.every((byte, index) => bytes[index] === byte)) return
  const label = platform === "win32" ? "Windows PE" : platform === "darwin" ? "macOS Mach-O" : "Linux ELF"
  throw new Error(`Packaged recovery CLI has an invalid ${label} header`)
}
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run:

```bash
cd packages/desktop
bun test scripts/recovery-cli-contract.test.ts
```

Expected: 2 passed, 0 failed.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/desktop/scripts/recovery-cli-contract.ts packages/desktop/scripts/recovery-cli-contract.test.ts
git commit -m "test(desktop): define packaged recovery CLI contract"
```

### Task 2: Build and stage exactly one host-native CLI

**Files:**

- Create: `packages/desktop/scripts/stage-recovery-cli.ts`
- Create: `packages/desktop/scripts/stage-recovery-cli.test.ts`
- Modify: `packages/desktop/scripts/prebuild.ts`
- Modify: `packages/desktop/.gitignore`

- [ ] **Step 1: Write failing staging and prebuild-order tests**

Create `packages/desktop/scripts/stage-recovery-cli.test.ts` with temporary fixtures that:

1. stage exact Windows bytes from `dist/bharatcode-windows-x64-baseline/bin/bharatcode.exe`;
2. stage exact Linux bytes from `dist/bharatcode-linux-x64-baseline/bin/bharatcode` and assert an executable bit;
3. reject zero candidate binaries;
4. reject two candidate binaries; and
5. assert `stage-recovery-cli.ts` appears before `build-node.ts` in `prebuild.ts`.

Use the public interface:

```ts
stageRecoveryCli({
  distDir,
  resourcesDir,
  platform: "win32" | "darwin" | "linux",
})
```

and assert the returned `{ source, destination }` paths.

- [ ] **Step 2: Run the staging test and verify RED**

Run:

```bash
cd packages/desktop
bun test scripts/stage-recovery-cli.test.ts
```

Expected: FAIL because `stage-recovery-cli.ts` does not exist and prebuild has no staging call.

- [ ] **Step 3: Implement the staging script**

Create `packages/desktop/scripts/stage-recovery-cli.ts` with:

```ts
#!/usr/bin/env bun
import { $ } from "bun"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { recoveryCliFilename, requireRecoveryCliPlatform } from "./recovery-cli-contract"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.resolve(desktopDir, "../opencode")

export async function stageRecoveryCli(input: { distDir: string; resourcesDir: string; platform: string }) {
  const platform = requireRecoveryCliPlatform(input.platform)
  const binary = platform === "win32" ? "bharatcode.exe" : "bharatcode"
  const matches = (
    await Array.fromAsync(new Bun.Glob(`*/bin/${binary}`).scan({ cwd: input.distDir, onlyFiles: true }))
  ).toSorted()
  if (matches.length !== 1) throw new Error(`Expected exactly one native recovery CLI, found ${matches.length}`)
  const source = path.join(input.distDir, matches[0]!)
  const destination = path.join(input.resourcesDir, recoveryCliFilename(platform))
  await mkdir(input.resourcesDir, { recursive: true })
  await copyFile(source, destination)
  if (platform !== "win32") await chmod(destination, 0o755)
  return { source, destination }
}

export async function buildAndStageRecoveryCli() {
  await $`bun script/build.ts --single --baseline`.cwd(opencodeDir)
  return stageRecoveryCli({
    distDir: path.join(opencodeDir, "dist"),
    resourcesDir: path.join(desktopDir, "resources"),
    platform: process.platform,
  })
}

if (import.meta.main) await buildAndStageRecoveryCli()
```

- [ ] **Step 4: Wire the correct prebuild order and ignore generated bytes**

In `packages/desktop/scripts/prebuild.ts`, insert:

```ts
await $`bun ./scripts/stage-recovery-cli.ts`
```

immediately before:

```ts
await $`cd ../opencode && bun script/build-node.ts`
```

Add this exact ignore pattern to `packages/desktop/.gitignore`:

```gitignore
resources/bharatcode-opencode-cli*
```

- [ ] **Step 5: Run staging tests and verify GREEN**

Run:

```bash
cd packages/desktop
bun test scripts/recovery-cli-contract.test.ts scripts/stage-recovery-cli.test.ts
```

Expected: all staging and contract tests pass with zero failures.

- [ ] **Step 6: Commit native CLI staging**

```bash
git add packages/desktop/.gitignore packages/desktop/scripts/prebuild.ts packages/desktop/scripts/stage-recovery-cli.ts packages/desktop/scripts/stage-recovery-cli.test.ts
git commit -m "fix(desktop): stage native recovery CLI"
```

### Task 3: Package once and verify the installed executable

**Files:**

- Modify: `packages/desktop/electron-builder.config.ts`
- Create: `packages/desktop/src/main/recovery-cli-packaging.test.ts`

- [ ] **Step 1: Write failing installed-layout tests**

Create `packages/desktop/src/main/recovery-cli-packaging.test.ts` to:

- load the exported `recoveryCliExtraResource`, `packagedRecoveryCliPath`, and `verifyRecoveryCliAfterPack`;
- assert the source resource is excluded from `files`;
- assert exactly one common `extraResources` mapping renames it to the fixed installed filename;
- create Windows, macOS, and Linux unpacked fixture layouts with valid headers;
- verify all three layouts pass;
- verify missing and malformed files fail; and
- verify macOS/Linux files without executable permission fail.

Use these exact expected installed suffixes:

```text
resources/bharatcode-opencode-cli.exe
BharatCode Beta.app/Contents/Resources/bharatcode-opencode-cli
resources/bharatcode-opencode-cli
```

- [ ] **Step 2: Run the packaging test and verify RED**

Run:

```bash
cd packages/desktop
bun test src/main/recovery-cli-packaging.test.ts
```

Expected: FAIL because the packaging helpers and `afterPack` verifier do not exist.

- [ ] **Step 3: Implement the common extra-resource mapping**

In `packages/desktop/electron-builder.config.ts`:

1. import `open` and `stat` from `node:fs/promises`;
2. import `recoveryCliFilename`, `requireRecoveryCliPlatform`, and
   `validateRecoveryCliHeader` from `./scripts/recovery-cli-contract`;
3. export:

```ts
export function recoveryCliExtraResource(platform = process.platform) {
  const filename = recoveryCliFilename(platform)
  return { from: `resources/${filename}`, to: filename }
}
```

4. change `files` to:

```ts
files: ["out/**/*", "resources/**/*", "!resources/bharatcode-opencode-cli*"],
```

5. append `recoveryCliExtraResource()` to the shared `extraResources` array.

- [ ] **Step 4: Implement exact installed-path and after-pack verification**

Export `packagedRecoveryCliPath` and `verifyRecoveryCliAfterPack`:

```ts
export function packagedRecoveryCliPath(context: {
  appOutDir: string
  electronPlatformName?: string
  packager?: { appInfo?: { productFilename?: string } }
}) {
  const platform = requireRecoveryCliPlatform(context.electronPlatformName ?? "")
  const filename = recoveryCliFilename(platform)
  if (platform !== "darwin") return path.join(context.appOutDir, "resources", filename)
  const product = context.packager?.appInfo?.productFilename
  if (!product) throw new Error("Packaged recovery CLI macOS product filename is missing")
  return path.join(context.appOutDir, `${product}.app`, "Contents", "Resources", filename)
}

export const verifyRecoveryCliAfterPack: NonNullable<Configuration["afterPack"]> = async (context) => {
  const platform = requireRecoveryCliPlatform(context.electronPlatformName)
  const target = packagedRecoveryCliPath(context)
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`Packaged recovery CLI is missing: ${target}`)
  if (platform !== "win32" && (info.mode & 0o111) === 0) {
    throw new Error(`Packaged recovery CLI is not executable: ${target}`)
  }
  const handle = await open(target, "r")
  const header = Buffer.alloc(4)
  try {
    await handle.read(header, 0, header.length, 0)
  } finally {
    await handle.close()
  }
  validateRecoveryCliHeader(platform, header)
}
```

Set the shared Electron Builder hook:

```ts
afterPack: verifyRecoveryCliAfterPack,
```

- [ ] **Step 5: Run packaging and startup-boundary tests**

Run:

```bash
cd packages/desktop
bun test \
  src/main/recovery-cli-packaging.test.ts \
  scripts/recovery-cli-contract.test.ts \
  scripts/stage-recovery-cli.test.ts \
  src/main/startup-recovery.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit the packaging contract**

```bash
git add packages/desktop/electron-builder.config.ts packages/desktop/src/main/recovery-cli-packaging.test.ts
git commit -m "fix(desktop): package recovery CLI on every platform"
```

### Task 4: Verify and freeze the product correction

**Files:**

- Verify all product files from Tasks 1–3.

- [ ] **Step 1: Run focused and complete Desktop tests**

Run from `packages/desktop`:

```bash
bun test \
  scripts/recovery-cli-contract.test.ts \
  scripts/stage-recovery-cli.test.ts \
  src/main/recovery-cli-packaging.test.ts \
  src/main/startup-recovery.test.ts
bun test
bun run typecheck
```

Expected: zero failures and typecheck exit 0.

- [ ] **Step 2: Run OpenCode tests and typecheck affected by the native CLI build**

Run from `packages/opencode`:

```bash
bun test test/distribution/lean-package.test.ts test/cli/doctor.test.ts
bun run typecheck
```

Expected: zero failures and typecheck exit 0.

- [ ] **Step 3: Execute the real Linux prebuild and unpacked package proof**

Run:

```bash
cd packages/desktop
bun run build
bunx electron-builder --linux --x64 --dir --config electron-builder.config.ts --publish never
test -x dist/linux-unpacked/resources/bharatcode-opencode-cli
dist/linux-unpacked/resources/bharatcode-opencode-cli --version
```

Expected: build and packaging exit 0; the installed CLI exists, is executable,
passes the `afterPack` ELF check, and prints the repository version.

- [ ] **Step 4: Run static release-scope checks**

Run from the repository worktree:

```bash
bunx prettier --check \
  packages/desktop/.gitignore \
  packages/desktop/scripts/recovery-cli-contract.ts \
  packages/desktop/scripts/recovery-cli-contract.test.ts \
  packages/desktop/scripts/stage-recovery-cli.ts \
  packages/desktop/scripts/stage-recovery-cli.test.ts \
  packages/desktop/scripts/prebuild.ts \
  packages/desktop/electron-builder.config.ts \
  packages/desktop/src/main/recovery-cli-packaging.test.ts \
  docs/superpowers/specs/2026-07-25-cross-platform-recovery-cli-packaging-design.md \
  docs/superpowers/plans/2026-07-25-cross-platform-recovery-cli-packaging.md
git diff --check
git status --short
```

Expected: formatting and diff checks pass; only intended source/docs files are
tracked, while the generated recovery CLI remains ignored.

- [ ] **Step 5: Record the exact product head**

Run:

```bash
git rev-parse HEAD
git status --porcelain
```

Expected: a lowercase 40-hex product head and an empty worktree.

### Task 5: Advance the preliminary source boundary

**Files:**

- Modify: `.github/workflows/bharatcode-preliminary-unsigned-wsl.yml`
- Modify: `packages/opencode/test/distribution/preliminary-unsigned-wsl-workflow.test.ts`

- [ ] **Step 1: Update the test constant first**

Replace `acceptedWslSha` in
`packages/opencode/test/distribution/preliminary-unsigned-wsl-workflow.test.ts`
with the exact 40-hex product head recorded in Task 4.

- [ ] **Step 2: Run the focused workflow test and verify RED**

Run:

```bash
cd packages/opencode
bun test test/distribution/preliminary-unsigned-wsl-workflow.test.ts
```

Expected: exactly the accepted-source assertion fails because the workflow
still contains the preceding accepted SHA.

- [ ] **Step 3: Advance only the workflow baseline**

Set `ACCEPTED_WSL_SOURCE_SHA` in
`.github/workflows/bharatcode-preliminary-unsigned-wsl.yml` to the same exact
40-hex product head. Do not change the protected-path list.

- [ ] **Step 4: Run the workflow and lifecycle tests and verify GREEN**

Run from `packages/opencode`:

```bash
bun test \
  test/distribution/preliminary-unsigned-wsl-workflow.test.ts \
  test/distribution/lean-preliminary-jit-lifecycle.test.ts
bun run typecheck
```

Expected: zero failures and typecheck exit 0.

- [ ] **Step 5: Commit the two-line source-boundary advance**

```bash
git add .github/workflows/bharatcode-preliminary-unsigned-wsl.yml packages/opencode/test/distribution/preliminary-unsigned-wsl-workflow.test.ts
git commit -m "fix(release): advance packaged recovery CLI baseline"
```

- [ ] **Step 6: Verify the final source and create an incremental bundle**

Verify:

```bash
git show --check --stat HEAD
git status --porcelain
sha256sum .github/workflows/bharatcode-next-beta-candidate.yml
```

Expected:

- clean worktree;
- only the two baseline files in the final commit; and
- final signed workflow SHA-256
  `79b4843c8249c820d0c58306aa2d39bddd0e8f52cc39ede627acf1ff9be9459f`.

Create and verify an incremental bundle from
`ecad2a62d788edceb4ce31ca362246386d9da045` through the final head, then report
its path, byte count, SHA-256, required parent, and contained branch head.
