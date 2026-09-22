import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseWslRuntimeManifest, verifyWslArtifact, type WslRuntimeManifest } from "./artifact"

const sourceSha = "9".repeat(40)
const version = "1.15.21"
const runtimeBytes = Buffer.from("external-glibc-runtime")
const digest = createHash("sha256").update(runtimeBytes).digest("hex")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function manifest(overrides: Partial<WslRuntimeManifest> = {}): WslRuntimeManifest {
  return {
    schema: 1,
    source_sha: sourceSha,
    version,
    arch: "x64",
    filename: "bharatcode-runtime-linux-x64-glibc",
    bytes: runtimeBytes.byteLength,
    sha256: digest,
    ...overrides,
  }
}

async function fixture(options?: { runtimeMode?: number; manifestMode?: number }) {
  const root = await mkdtemp(join(tmpdir(), "bharatcode-wsl-artifact-"))
  roots.push(root)
  const runtimePath = join(root, "bharatcode-runtime-linux-x64-glibc")
  const manifestPath = join(root, "manifest.json")
  await writeFile(runtimePath, runtimeBytes, { mode: options?.runtimeMode ?? 0o444 })
  await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`, { mode: options?.manifestMode ?? 0o444 })
  await chmod(runtimePath, options?.runtimeMode ?? 0o444)
  await chmod(manifestPath, options?.manifestMode ?? 0o444)
  return { root, runtimePath, manifestPath }
}

describe("closed WSL runtime artifact", () => {
  test("verifies one immutable external glibc runtime and freezes its identity seam", async () => {
    const input = await fixture()
    const verified = await verifyWslArtifact({
      runtimePath: input.runtimePath,
      manifestPath: input.manifestPath,
      expectedSourceSha: sourceSha,
      expectedVersion: version,
      expectedArch: "x64",
    })

    expect(verified).toEqual(manifest())
    expect(Object.isFrozen(verified)).toBe(true)
  })

  test("rejects open manifest shapes and non-canonical identities", () => {
    for (const value of [
      { ...manifest(), token: "private" },
      { ...manifest(), schema: 2 },
      { ...manifest(), source_sha: "A".repeat(40) },
      { ...manifest(), version: "1.15" },
      { ...manifest(), arch: "ia32" },
      { ...manifest(), filename: "../../runtime" },
      { ...manifest(), filename: "bharatcode-runtime-linux-arm64-glibc" },
      { ...manifest(), bytes: 0 },
      { ...manifest(), sha256: "A".repeat(64) },
    ]) {
      expect(() => parseWslRuntimeManifest(value)).toThrow()
    }
  })

  test("rejects missing, writable, symlink, non-file, empty, and mismatched inputs", async () => {
    const input = await fixture()
    const writable = await fixture({ runtimeMode: 0o644 })
    const writableManifest = await fixture({ manifestMode: 0o644 })
    const empty = await fixture()
    await chmod(empty.runtimePath, 0o644)
    await writeFile(empty.runtimePath, "")
    await chmod(empty.runtimePath, 0o444)
    const symlinkRoot = await mkdtemp(join(tmpdir(), "bharatcode-wsl-symlink-"))
    roots.push(symlinkRoot)
    const symlinkPath = join(symlinkRoot, manifest().filename)
    await symlink(input.runtimePath, symlinkPath)
    const directory = join(symlinkRoot, "directory")
    await mkdir(directory)

    const base = {
      manifestPath: input.manifestPath,
      expectedSourceSha: sourceSha,
      expectedVersion: version,
      expectedArch: "x64" as const,
    }
    for (const request of [
      { ...base, runtimePath: join(input.root, "missing") },
      { ...base, runtimePath: writable.runtimePath, manifestPath: writable.manifestPath },
      { ...base, runtimePath: writableManifest.runtimePath, manifestPath: writableManifest.manifestPath },
      { ...base, runtimePath: symlinkPath },
      { ...base, runtimePath: directory },
      { ...base, runtimePath: empty.runtimePath, manifestPath: empty.manifestPath },
      { ...base, runtimePath: input.runtimePath, expectedSourceSha: "8".repeat(40) },
      { ...base, runtimePath: input.runtimePath, expectedVersion: "1.15.22" },
      { ...base, runtimePath: input.runtimePath, expectedArch: "arm64" as const },
    ]) {
      await expect(verifyWslArtifact(request)).rejects.toThrow()
    }
  })

  test("rejects byte and digest drift", async () => {
    const input = await fixture()
    await chmod(input.runtimePath, 0o644)
    await writeFile(input.runtimePath, Buffer.from("different-runtime"))
    await chmod(input.runtimePath, 0o444)

    await expect(
      verifyWslArtifact({
        runtimePath: input.runtimePath,
        manifestPath: input.manifestPath,
        expectedSourceSha: sourceSha,
        expectedVersion: version,
        expectedArch: "x64",
      }),
    ).rejects.toThrow(/bytes|sha-256/i)
  })

  test("rejects hard-linked artifacts even with matching content", async () => {
    const input = await fixture()
    await link(input.runtimePath, join(input.root, "alias"))
    await expect(
      verifyWslArtifact({ ...input, expectedSourceSha: sourceSha, expectedVersion: version, expectedArch: "x64" }),
    ).rejects.toThrow("immutable")
  })
})
