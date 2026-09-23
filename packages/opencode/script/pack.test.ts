import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createPlatformPackageManifest,
  PLATFORM_TARGETS,
  platformBinaryName,
  platformPackageName,
} from "./distribution.mjs"
import { pack } from "./pack"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bharatcode-pack-test-"))
  const dist = path.join(root, "dist")
  await mkdir(dist)
  for (const target of PLATFORM_TARGETS) {
    const directory = path.join(dist, platformPackageName(target))
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify(createPlatformPackageManifest(target, "1.15.35")),
    )
    await Bun.write(path.join(directory, "bin", platformBinaryName(target.os)), "synthetic binary fixture")
  }
  return {
    root,
    dist,
    output: path.join(root, "out"),
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("packs the complete branded CLI cohort without a postinstall or publication step", async () => {
  await using input = await fixture()
  const result = await pack(input.dist, input.output)
  expect(result.version).toBe("1.15.35")
  expect(result.packages).toHaveLength(13)
  expect(result.packages.at(-1)?.name).toBe("bharatcode")
  const meta = result.packages.at(-1)!
  const archive = new Bun.Archive(await Bun.file(path.join(input.output, meta.file)).arrayBuffer())
  const files = await archive.files()
  const manifest = await files.get("package/package.json")!.json()
  expect(manifest.name).toBe("bharatcode")
  expect(manifest.bin).toEqual({ bharatcode: "bin/bharatcode.mjs" })
  expect(manifest.scripts).toBeUndefined()
  expect(Object.keys(manifest.optionalDependencies)).toHaveLength(12)
  expect(new Set(Object.values(manifest.optionalDependencies))).toEqual(new Set(["1.15.35"]))
  expect(files.has("package/script/distribution.mjs")).toBe(true)
  expect(files.has("package/bin/bharatcode.mjs")).toBe(true)
  expect(await Bun.file(path.join(input.output, "manifest.json")).json()).toEqual(result)
  for (const entry of result.packages) {
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(entry.size).toBeGreaterThan(0)
  }
  await expect(pack(input.dist, input.output)).rejects.toThrow()
}, 30_000)

test("rejects mixed versions before creating an output directory", async () => {
  await using input = await fixture()
  const target = PLATFORM_TARGETS[0]
  await Bun.write(
    path.join(input.dist, platformPackageName(target), "package.json"),
    JSON.stringify(createPlatformPackageManifest(target, "1.15.34")),
  )
  await expect(pack(input.dist, input.output)).rejects.toThrow("manifest")
  expect(await Bun.file(path.join(input.output, "manifest.json")).exists()).toBe(false)
})

test("rejects incomplete or unexpected platform cohorts", async () => {
  await using input = await fixture()
  await rm(path.join(input.dist, platformPackageName(PLATFORM_TARGETS[0])), { recursive: true })
  await expect(pack(input.dist, input.output)).rejects.toThrow("platform")
  await mkdir(path.join(input.dist, "unexpected"))
  await expect(pack(input.dist, input.output)).rejects.toThrow("platform")
})

test("rejects unexpected lifecycle scripts and empty binaries before packing", async () => {
  await using input = await fixture()
  const target = PLATFORM_TARGETS[0]
  const directory = path.join(input.dist, platformPackageName(target))
  const manifest = createPlatformPackageManifest(target, "1.15.35")
  await Bun.write(path.join(directory, "package.json"), JSON.stringify({ ...manifest, scripts: { prepack: "exit 1" } }))
  await expect(pack(input.dist, input.output)).rejects.toThrow("manifest")
  await Bun.write(path.join(directory, "package.json"), JSON.stringify(manifest))
  await Bun.write(path.join(directory, "bin", platformBinaryName(target.os)), "")
  await expect(pack(input.dist, input.output)).rejects.toThrow("binary")
})
