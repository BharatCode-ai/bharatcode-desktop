#!/usr/bin/env bun
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { verifyWslArtifact, type WslRuntimeArch } from "../src/main/wsl-artifact"

export async function stageWslRuntime(input: {
  runtimePath: string
  manifestPath: string
  destinationDirectory: string
  expectedSourceSha: string
  expectedVersion: string
  expectedArch: WslRuntimeArch
}) {
  const manifest = await verifyWslArtifact(input)
  await mkdir(dirname(input.destinationDirectory), { recursive: true })
  await mkdir(input.destinationDirectory)
  const runtimePath = join(input.destinationDirectory, manifest.filename)
  const manifestPath = join(input.destinationDirectory, "manifest.json")
  try {
    await copyFile(input.runtimePath, runtimePath)
    await chmod(runtimePath, 0o444)
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o444 })
    await chmod(manifestPath, 0o444)
    await verifyWslArtifact({
      runtimePath,
      manifestPath,
      expectedSourceSha: input.expectedSourceSha,
      expectedVersion: input.expectedVersion,
      expectedArch: input.expectedArch,
    })
    return { runtimePath, manifestPath }
  } catch (error) {
    await rm(input.destinationDirectory, { recursive: true, force: true })
    throw error
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required WSL staging input: ${name}`)
  return value
}

export async function stageWslRuntimeFromEnvironment(input: {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  packageVersion: string
}) {
  const expectedSourceSha = required(input.env, "INTEGRATED_HEAD")
  const runtimePath = required(input.env, "BHARATCODE_WSL_RUNTIME")
  const manifestPath = required(input.env, "BHARATCODE_WSL_RUNTIME_MANIFEST")
  const rawArch = required(input.env, "BHARATCODE_WSL_RUNTIME_ARCH")
  if (rawArch !== "x64" && rawArch !== "arm64") throw new Error("Invalid BHARATCODE_WSL_RUNTIME_ARCH")
  return stageWslRuntime({
    runtimePath,
    manifestPath,
    destinationDirectory: join(input.cwd, "resources", "wsl-runtime"),
    expectedSourceSha,
    expectedVersion: input.packageVersion,
    expectedArch: rawArch,
  })
}

if (import.meta.main) {
  const packageJson = await Bun.file(join(import.meta.dir, "..", "package.json")).json()
  const result = await stageWslRuntimeFromEnvironment({
    cwd: join(import.meta.dir, ".."),
    env: Bun.env,
    packageVersion: packageJson.version,
  })
  console.log(`Staged verified WSL runtime: ${result.runtimePath}`)
}
