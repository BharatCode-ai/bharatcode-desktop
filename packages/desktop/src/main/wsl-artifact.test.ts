import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installWslRuntime, parseWslRuntimeManifest, verifyWslArtifact, type WslRuntimeManifest } from "./wsl-artifact"
import type { WslExecute } from "./wsl-distro"

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
})

describe("selected-distro WSL runtime installation", () => {
  test("uses argument arrays and canonical Linux StoragePaths bin without storage overrides", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const expectedBin = "/home/private-user/.cache/bharatcode-beta/bin"
    const expectedPath = `${expectedBin}/${manifest().filename}`
    const execute: WslExecute = async (executable, args) => {
      calls.push({ executable, args })
      if (args.includes("/usr/bin/sha256sum")) return { stdout: `${digest} *${expectedPath}\n` }
      if (args.includes("/usr/bin/stat")) return { stdout: `${runtimeBytes.byteLength}\n` }
      return { stdout: "" }
    }

    const result = await installWslRuntime({
      wslExecutable: "C:\\Windows\\System32\\wsl.exe",
      execute,
      selectedDisplayName: "Ubuntu 24.04",
      selectedUser: "private-user",
      selectedUid: 1000,
      home: "/home/private-user",
      channel: "beta",
      runtimeSourceLinuxPath: `/mnt/c/Program Files/BharatCode/resources/wsl-runtime/${manifest().filename}`,
      manifest: manifest(),
    })

    expect(result).toEqual({ ...manifest(), installedPath: expectedPath })
    expect(Object.isFrozen(result)).toBe(true)
    expect(calls.map((call) => call.executable)).toEqual(Array(calls.length).fill("C:\\Windows\\System32\\wsl.exe"))
    expect(calls[0].args).toEqual([
      "--distribution",
      "Ubuntu 24.04",
      "--user",
      "private-user",
      "--exec",
      "/usr/bin/install",
      "--directory",
      "--mode=0700",
      "--",
      expectedBin,
    ])
    expect(calls[1].args).toEqual([
      "--distribution",
      "Ubuntu 24.04",
      "--user",
      "private-user",
      "--exec",
      "/usr/bin/install",
      "--mode=0500",
      "--",
      `/mnt/c/Program Files/BharatCode/resources/wsl-runtime/${manifest().filename}`,
      expectedPath,
    ])
    expect(JSON.stringify(calls)).not.toMatch(/XDG_|BHARATCODE_(?:DB|AUTH|CONFIG|DATA|STATE|CACHE|LOG|TEMP|TOOLS)/)
  })

  test("rejects root and installed byte or digest mismatch", async () => {
    const base = {
      wslExecutable: "C:\\Windows\\System32\\wsl.exe",
      selectedDisplayName: "Ubuntu",
      selectedUser: "private-user",
      home: "/home/private-user",
      channel: "prod",
      runtimeSourceLinuxPath: `/mnt/c/${manifest().filename}`,
      manifest: manifest(),
    }
    await expect(installWslRuntime({ ...base, selectedUid: 0, execute: async () => ({ stdout: "" }) })).rejects.toThrow(
      "non-root",
    )
    await expect(
      installWslRuntime({
        ...base,
        runtimeSourceLinuxPath: "/mnt/c/different-runtime",
        selectedUid: 1000,
        execute: async () => ({ stdout: "" }),
      }),
    ).rejects.toThrow("filename")
    await expect(
      installWslRuntime({
        ...base,
        selectedUid: 1000,
        execute: async (_executable, args) => {
          if (args.includes("/usr/bin/sha256sum")) return { stdout: `${"0".repeat(64)} *runtime\n` }
          if (args.includes("/usr/bin/stat")) return { stdout: `${runtimeBytes.byteLength}\n` }
          return { stdout: "" }
        },
      }),
    ).rejects.toThrow(/sha-256/i)
  })
})
