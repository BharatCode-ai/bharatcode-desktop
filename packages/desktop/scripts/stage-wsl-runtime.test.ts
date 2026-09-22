import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stageWslRuntime, stageWslRuntimeFromEnvironment } from "./stage-wsl-runtime"

const roots: string[] = []
const sourceSha = "9".repeat(40)
const version = "1.15.21"
const runtime = Buffer.from("external-glibc-runtime")
const sha256 = createHash("sha256").update(runtime).digest("hex")

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bharatcode-stage-wsl-"))
  roots.push(root)
  const sourceDirectory = join(root, "external")
  const destinationDirectory = join(root, "resources", "wsl-runtime")
  await mkdir(sourceDirectory, { recursive: true })
  const runtimePath = join(sourceDirectory, "bharatcode-runtime-linux-x64-glibc")
  const manifestPath = join(sourceDirectory, "manifest.json")
  await writeFile(runtimePath, runtime, { mode: 0o444 })
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schema: 1,
      source_sha: sourceSha,
      version,
      arch: "x64",
      filename: "bharatcode-runtime-linux-x64-glibc",
      bytes: runtime.byteLength,
      sha256,
    })}\n`,
    { mode: 0o444 },
  )
  await chmod(runtimePath, 0o444)
  await chmod(manifestPath, 0o444)
  return { root, runtimePath, manifestPath, destinationDirectory }
}

describe("WSL runtime packaging stage", () => {
  test("copies only a verified immutable runtime and canonical manifest", async () => {
    const input = await fixture()
    const result = await stageWslRuntime({
      runtimePath: input.runtimePath,
      manifestPath: input.manifestPath,
      destinationDirectory: input.destinationDirectory,
      expectedSourceSha: sourceSha,
      expectedVersion: version,
      expectedArch: "x64",
    })

    expect(result).toEqual({
      runtimePath: join(input.destinationDirectory, "bharatcode-runtime-linux-x64-glibc"),
      manifestPath: join(input.destinationDirectory, "manifest.json"),
    })
    expect(await readFile(result.runtimePath)).toEqual(runtime)
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({ source_sha: sourceSha, sha256 })
    expect((await stat(result.runtimePath)).mode & 0o222).toBe(0)
    expect((await stat(result.manifestPath)).mode & 0o222).toBe(0)
  })

  test("requires closed build inputs before the package command", async () => {
    const input = await fixture()
    await expect(
      stageWslRuntimeFromEnvironment({
        cwd: input.root,
        env: {},
        packageVersion: version,
      }),
    ).rejects.toThrow("BHARATCODE_SOURCE_SHA")
    await expect(
      stageWslRuntimeFromEnvironment({
        cwd: input.root,
        packageVersion: version,
        env: {
          BHARATCODE_SOURCE_SHA: sourceSha,
          BHARATCODE_WSL_RUNTIME: input.runtimePath,
          BHARATCODE_WSL_RUNTIME_MANIFEST: input.manifestPath,
          BHARATCODE_WSL_RUNTIME_ARCH: "x64",
        },
      }),
    ).resolves.toEqual({
      runtimePath: join(input.root, "resources", "wsl-runtime", "bharatcode-runtime-linux-x64-glibc"),
      manifestPath: join(input.root, "resources", "wsl-runtime", "manifest.json"),
    })
  })

  test("never overwrites or removes a pre-existing staging directory", async () => {
    const input = await fixture()
    await mkdir(input.destinationDirectory, { recursive: true })
    const sentinel = join(input.destinationDirectory, "existing")
    await writeFile(sentinel, "preserve")
    await expect(
      stageWslRuntime({ ...input, expectedSourceSha: sourceSha, expectedVersion: version, expectedArch: "x64" }),
    ).rejects.toThrow()
    expect(await readFile(sentinel, "utf8")).toBe("preserve")
  })
})
