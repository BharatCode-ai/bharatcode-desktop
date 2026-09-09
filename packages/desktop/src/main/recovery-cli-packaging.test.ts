import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import configuration, {
  packagedRecoveryCliPath,
  recoveryCliExtraResource,
  verifyRecoveryCliAfterPack,
} from "../../electron-builder.config"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function output() {
  const root = await mkdtemp(path.join(tmpdir(), "bharatcode-packaged-recovery-"))
  roots.push(root)
  return root
}

function context(platform: "win32" | "darwin" | "linux", appOutDir: string) {
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: "BharatCode Beta" } },
  }
}

function validPeHeader() {
  const bytes = new Uint8Array(128)
  bytes.set([0x4d, 0x5a])
  new DataView(bytes.buffer).setUint32(0x3c, 0x40, true)
  bytes.set([0x50, 0x45, 0x00, 0x00], 0x40)
  return bytes
}

async function executable(target: string, bytes: Uint8Array, mode = 0o755) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes)
  await chmod(target, mode)
}

describe("packaged recovery CLI", () => {
  test("maps one generated executable outside app.asar on every platform", () => {
    expect(recoveryCliExtraResource("win32")).toEqual({
      from: "resources/bharatcode-opencode-cli.exe",
      to: "bharatcode-opencode-cli.exe",
    })
    expect(recoveryCliExtraResource("darwin")).toEqual({
      from: "resources/bharatcode-opencode-cli",
      to: "bharatcode-opencode-cli",
    })
    expect(recoveryCliExtraResource("linux")).toEqual({
      from: "resources/bharatcode-opencode-cli",
      to: "bharatcode-opencode-cli",
    })
    expect(configuration.files).toContain("!resources/bharatcode-opencode-cli*")
    expect(
      (configuration.extraResources ?? []).filter(
        (entry) => typeof entry === "object" && entry !== null && entry.to === recoveryCliExtraResource().to,
      ),
    ).toEqual([recoveryCliExtraResource()])
  })

  test("resolves the exact process.resourcesPath layout on every platform", async () => {
    const root = await output()
    expect(packagedRecoveryCliPath(context("win32", root))).toBe(
      path.join(root, "resources", "bharatcode-opencode-cli.exe"),
    )
    expect(packagedRecoveryCliPath(context("darwin", root))).toBe(
      path.join(root, "BharatCode Beta.app", "Contents", "Resources", "bharatcode-opencode-cli"),
    )
    expect(packagedRecoveryCliPath(context("linux", root))).toBe(
      path.join(root, "resources", "bharatcode-opencode-cli"),
    )
  })

  test("accepts valid PE, Mach-O, and ELF files at the installed path", async () => {
    for (const [platform, bytes] of [
      ["win32", validPeHeader()],
      ["darwin", Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe])],
      ["linux", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])],
    ] as const) {
      const value = context(platform, await output())
      await executable(packagedRecoveryCliPath(value), bytes)
      await expect(verifyRecoveryCliAfterPack(value as never)).resolves.toBeUndefined()
    }
  })

  test("rejects missing, malformed, and non-executable packaged files", async () => {
    const missing = context("win32", await output())
    await expect(verifyRecoveryCliAfterPack(missing as never)).rejects.toThrow("Packaged recovery CLI is missing")

    const malformed = context("linux", await output())
    await executable(packagedRecoveryCliPath(malformed), Uint8Array.from([0x4d, 0x5a]))
    await expect(verifyRecoveryCliAfterPack(malformed as never)).rejects.toThrow("invalid Linux ELF header")

    const truncatedPe = context("win32", await output())
    await executable(packagedRecoveryCliPath(truncatedPe), Uint8Array.from([0x4d, 0x5a]))
    await expect(verifyRecoveryCliAfterPack(truncatedPe as never)).rejects.toThrow("invalid Windows PE header")

    const permission = context("darwin", await output())
    await executable(packagedRecoveryCliPath(permission), Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]), 0o644)
    await expect(verifyRecoveryCliAfterPack(permission as never)).rejects.toThrow(
      "Packaged recovery CLI is not executable",
    )
  })
})
