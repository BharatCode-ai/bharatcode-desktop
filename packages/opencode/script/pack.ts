#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  createPlatformPackageManifest,
  DISTRIBUTION,
  PLATFORM_TARGETS,
  platformBinaryName,
  platformPackageName,
} from "./distribution.mjs"

export function createMetaPackageManifest(version: string) {
  return {
    name: DISTRIBUTION.npmPackage,
    version,
    license: "MIT",
    repository: { type: "git", url: `git+https://github.com/${DISTRIBUTION.repository}.git` },
    type: "module",
    bin: { [DISTRIBUTION.commandName]: "bin/bharatcode.mjs" },
    files: ["bin", "script/distribution.mjs", "LICENSE"],
    optionalDependencies: Object.fromEntries(PLATFORM_TARGETS.map((target) => [platformPackageName(target), version])),
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
  }
}

/** Assemble tarballs only. Registry publication requires a separate, authorized workflow. */
export async function pack(dist: string, output: string) {
  const names = PLATFORM_TARGETS.map(platformPackageName)
  const entries = await readdir(dist, { withFileTypes: true })
  if (entries.length !== names.length || entries.some((entry) => !entry.isDirectory() || !names.includes(entry.name))) {
    throw new Error("CLI platform cohort is incomplete or unexpected")
  }
  const version = (await Bun.file(path.join(dist, names[0], "package.json")).json()).version
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid CLI manifest version")
  }
  for (const target of PLATFORM_TARGETS) {
    const directory = path.join(dist, platformPackageName(target))
    const manifest = path.join(directory, "package.json")
    if (!(await lstat(manifest)).isFile()) throw new Error("Invalid CLI manifest file")
    if (!isDeepStrictEqual(await Bun.file(manifest).json(), createPlatformPackageManifest(target, version))) {
      throw new Error("CLI manifest does not match its platform and cohort version")
    }
    const bin = path.join(directory, "bin")
    if (!(await lstat(bin)).isDirectory()) throw new Error("Invalid CLI binary directory")
    const binary = path.join(bin, platformBinaryName(target.os))
    if (!(await lstat(binary)).isFile() || (await lstat(binary)).size === 0) {
      throw new Error("Missing CLI platform binary")
    }
    if (!isDeepStrictEqual((await readdir(bin)).sort(), [platformBinaryName(target.os)])) {
      throw new Error("Unexpected CLI platform binary contents")
    }
  }

  // Refuse to mix a prior or partially built cohort into this one.
  await mkdir(output)
  const staging = await mkdtemp(path.join(tmpdir(), "bharatcode-npm-pack-"))
  try {
    await mkdir(path.join(staging, "bin"))
    await mkdir(path.join(staging, "script"))
    await copyFile(path.join(import.meta.dirname, "../bin/bharatcode.mjs"), path.join(staging, "bin/bharatcode.mjs"))
    await chmod(path.join(staging, "bin/bharatcode.mjs"), 0o755)
    await copyFile(path.join(import.meta.dirname, "distribution.mjs"), path.join(staging, "script/distribution.mjs"))
    await copyFile(path.join(import.meta.dirname, "../../../LICENSE"), path.join(staging, "LICENSE"))
    await Bun.write(path.join(staging, "package.json"), JSON.stringify(createMetaPackageManifest(version)))
    const packages: { name: string; file: string; size: number; sha256: string }[] = []
    for (const name of [...names, DISTRIBUTION.npmPackage]) {
      const directory = name === DISTRIBUTION.npmPackage ? staging : path.join(dist, name)
      const result = Bun.spawn([process.execPath, "pm", "pack", "--destination", path.resolve(output)], {
        cwd: directory,
        stdout: "ignore",
        stderr: "inherit",
      })
      if ((await result.exited) !== 0) throw new Error(`CLI packing failed: ${name}`)
      const file = `${name}-${version}.tgz`
      const bytes = await Bun.file(path.join(output, file)).arrayBuffer()
      packages.push({
        name,
        file,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      })
    }
    const result = { version, packages }
    await Bun.write(path.join(output, "manifest.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const result = await pack(
    path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../dist")),
    path.resolve(process.argv[3] ?? path.join(import.meta.dirname, "../out")),
  )
  console.log(`Packed ${result.packages.length} CLI packages for ${result.version}; nothing published.`)
}
