import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, readFile, readdir, appendFile, link } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createPlatformPackageManifest,
  PLATFORM_TARGETS,
  platformBinaryName,
  platformPackageName,
} from "./distribution.mjs"
import { pack } from "./pack"
import { createHash } from "node:crypto"
import { verifyCandidate } from "./verify-candidate"

const identity = {
  source: "a".repeat(40),
  tree: "b".repeat(40),
  version: "1.15.35",
  channel: "beta" as const,
  repository: "BharatCode-ai/bharatcode-desktop",
  run: "123",
  attempt: "1",
}

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

test("verifies exact packed bytes/source and orders all platform publications before the wrapper", async () => {
  await using input = await fixture()
  await pack(input.dist, input.output)
  await Bun.write(path.join(input.output, "source.json"), JSON.stringify(identity))
  const manifest = await readFile(path.join(input.output, "manifest.json"))
  const digest = createHash("sha256").update(manifest).digest("hex")
  const verified = await verifyCandidate(input.output, identity, digest)
  expect(verified.version).toBe(identity.version)
  expect(verified.packages.map((item) => item.name)).toEqual([
    ...PLATFORM_TARGETS.map(platformPackageName),
    "bharatcode",
  ])
  for (const item of verified.packages) {
    const content = await readFile(path.join(input.output, item.file))
    expect(item.integrity).toBe(`sha512-${createHash("sha512").update(content).digest("base64")}`)
  }
  await expect(verifyCandidate(input.output, identity, "f".repeat(64))).rejects.toThrow()
  await expect(verifyCandidate(input.output, { ...identity, attempt: "2" }, digest)).rejects.toThrow()
  const archive = path.join(input.output, verified.packages[0].file)
  await appendFile(archive, "drift")
  await expect(verifyCandidate(input.output, identity, digest)).rejects.toThrow()
}, 30_000)

test("verification rejects extra files, hardlinks, forged package identity and rehashed injected lifecycle scripts", async () => {
  await using input = await fixture()
  await pack(input.dist, input.output)
  await Bun.write(path.join(input.output, "source.json"), JSON.stringify(identity))
  const file = path.join(input.output, "manifest.json")
  const original = await readFile(file)
  const digest = createHash("sha256").update(original).digest("hex")
  await Bun.write(path.join(input.output, "extra.tgz"), "unexpected")
  await expect(verifyCandidate(input.output, identity, digest)).rejects.toThrow()
  await rm(path.join(input.output, "extra.tgz"))
  const manifest = JSON.parse(original.toString())
  const target = path.join(input.output, manifest.packages[0].file)
  await link(target, path.join(input.root, "outside.tgz"))
  await expect(verifyCandidate(input.output, identity, digest)).rejects.toThrow()
  await rm(path.join(input.root, "outside.tgz"))
  const archive = new Bun.Archive(await readFile(target))
  const files = await archive.files()
  const metadata = await files.get("package/package.json")!.json()
  for (const change of [{ name: "wrong-package" }, { scripts: { prepublishOnly: "exit 1" } }]) {
    const replacement = new Bun.Archive({
      "package/package.json": JSON.stringify({ ...metadata, ...change }),
      "package/bin/bharatcode": "synthetic binary fixture",
    })
    const content = new Uint8Array(await replacement.bytes())
    await Bun.write(target, content)
    manifest.packages[0].size = content.length
    manifest.packages[0].sha256 = createHash("sha256").update(content).digest("hex")
    const changed = Buffer.from(JSON.stringify(manifest))
    await Bun.write(file, changed)
    await expect(
      verifyCandidate(input.output, identity, createHash("sha256").update(changed).digest("hex")),
    ).rejects.toThrow()
  }
  expect((await readdir(input.output)).length).toBe(15)
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
