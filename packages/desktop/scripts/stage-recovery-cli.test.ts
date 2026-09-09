import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { stageRecoveryCli } from "./stage-recovery-cli"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bharatcode-recovery-cli-"))
  roots.push(root)
  return {
    distDir: path.join(root, "dist"),
    resourcesDir: path.join(root, "resources"),
  }
}

async function binary(distDir: string, name: string, filename: string, bytes: Uint8Array) {
  const target = path.join(distDir, name, "bin", filename)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes)
  await chmod(target, 0o755)
  return target
}

describe("recovery CLI staging", () => {
  test("copies the exact Windows CLI bytes to the fixed generated resource", async () => {
    const value = await fixture()
    const source = await binary(
      value.distDir,
      "bharatcode-windows-x64",
      "bharatcode.exe",
      Uint8Array.from([0x4d, 0x5a, 0x01, 0x02]),
    )
    const result = await stageRecoveryCli({ ...value, platform: "win32", arch: "x64" })

    expect(result).toEqual({
      source,
      destination: path.join(value.resourcesDir, "bharatcode-opencode-cli.exe"),
    })
    expect(await readFile(result.destination)).toEqual(Buffer.from([0x4d, 0x5a, 0x01, 0x02]))
  })

  test("copies the exact Unix CLI bytes and preserves executable authority", async () => {
    const value = await fixture()
    const source = await binary(
      value.distDir,
      "bharatcode-linux-x64",
      "bharatcode",
      Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x01]),
    )
    const result = await stageRecoveryCli({ ...value, platform: "linux", arch: "x64" })

    expect(result.source).toBe(source)
    expect(await readFile(result.destination)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]))
    expect((await stat(result.destination)).mode & 0o111).not.toBe(0)
  })

  test("rejects a missing exact target and ignores other build variants", async () => {
    const missing = await fixture()
    await binary(
      missing.distDir,
      "bharatcode-darwin-x64-baseline",
      "bharatcode",
      Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]),
    )
    await expect(stageRecoveryCli({ ...missing, platform: "darwin", arch: "x64" })).rejects.toThrow(
      "Native recovery CLI is missing",
    )

    const variants = await fixture()
    await binary(variants.distDir, "bharatcode-linux-x64-baseline", "bharatcode", Uint8Array.from([0x01]))
    await binary(variants.distDir, "bharatcode-linux-x64-baseline-musl", "bharatcode", Uint8Array.from([0x02]))
    const source = await binary(
      variants.distDir,
      "bharatcode-linux-x64",
      "bharatcode",
      Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]),
    )
    const result = await stageRecoveryCli({ ...variants, platform: "linux", arch: "x64" })
    expect(result.source).toBe(source)
    expect(await readFile(result.destination)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  })

  test("builds the native CLI before rebuilding the Node service", async () => {
    const source = await Bun.file(new URL("./prebuild.ts", import.meta.url)).text()
    const recovery = source.indexOf("stage-recovery-cli.ts")
    const node = source.indexOf("build-node.ts")

    expect(recovery).toBeGreaterThan(-1)
    expect(node).toBeGreaterThan(recovery)
  })

  test("uses the frozen workspace install instead of mutating native dependencies during packaging", async () => {
    const source = await Bun.file(new URL("./stage-recovery-cli.ts", import.meta.url)).text()

    expect(source).toContain("bun script/build.ts --single --skip-install")
    expect(source).not.toContain("--baseline")
    expect(source).not.toContain("bun script/build.ts --single`")
  })
})
