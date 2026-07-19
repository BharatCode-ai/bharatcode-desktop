import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { basename, posix } from "node:path"
import * as StoragePaths from "../../../core/src/storage-paths"
import { isSafeWslDisplayName } from "./wsl-contract"
import type { WslExecute } from "./wsl-distro"

export type WslRuntimeArch = "x64" | "arm64"

export type WslRuntimeManifest = {
  schema: 1
  source_sha: string
  version: string
  arch: WslRuntimeArch
  filename: string
  bytes: number
  sha256: string
}

export type InstalledWslRuntime = Readonly<WslRuntimeManifest & { installedPath: string }>

const manifestKeys = ["schema", "source_sha", "version", "arch", "filename", "bytes", "sha256"]

function exactRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === manifestKeys.length && keys.every((key, index) => key === [...manifestKeys].sort()[index])
}

export function wslRuntimeFilename(arch: WslRuntimeArch) {
  return `bharatcode-runtime-linux-${arch}-glibc`
}

export function parseWslRuntimeManifest(value: unknown): WslRuntimeManifest {
  if (!exactRecord(value)) throw new Error("WSL runtime manifest must use the closed schema")
  if (value.schema !== 1) throw new Error("Unsupported WSL runtime manifest schema")
  if (typeof value.source_sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.source_sha)) {
    throw new Error("WSL runtime source SHA must be exact lowercase 40-hex")
  }
  if (typeof value.version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version)) {
    throw new Error("WSL runtime version must be canonical semver")
  }
  if (value.arch !== "x64" && value.arch !== "arm64") throw new Error("Unsupported WSL runtime architecture")
  if (value.filename !== wslRuntimeFilename(value.arch))
    throw new Error("WSL runtime filename does not match architecture")
  if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error("WSL runtime byte count must be positive")
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new Error("WSL runtime SHA-256 must be exact lowercase 64-hex")
  }
  return {
    schema: 1,
    source_sha: value.source_sha,
    version: value.version,
    arch: value.arch,
    filename: value.filename,
    bytes: value.bytes,
    sha256: value.sha256,
  }
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number; nlink: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number; nlink: number },
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  )
}

async function readImmutableFile(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path).catch(() => {
    throw new Error(`${label} is missing`)
  })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  if (before.nlink !== 1 || (before.mode & 0o222) !== 0) throw new Error(`${label} must be immutable and non-writable`)

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new Error(`${label} changed before verification`)
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!sameFileIdentity(opened, after)) throw new Error(`${label} changed during verification`)
    return bytes
  } finally {
    await handle.close()
  }
}

export async function verifyWslArtifact(input: {
  runtimePath: string
  manifestPath: string
  expectedSourceSha: string
  expectedVersion: string
  expectedArch: WslRuntimeArch
}): Promise<Readonly<WslRuntimeManifest>> {
  const manifestBytes = await readImmutableFile(input.manifestPath, "WSL runtime manifest")
  let decoded: unknown
  try {
    decoded = JSON.parse(manifestBytes.toString("utf8"))
  } catch {
    throw new Error("WSL runtime manifest is not valid JSON")
  }
  const manifest = parseWslRuntimeManifest(decoded)
  if (manifest.source_sha !== input.expectedSourceSha) throw new Error("WSL runtime source SHA mismatch")
  if (manifest.version !== input.expectedVersion) throw new Error("WSL runtime version mismatch")
  if (manifest.arch !== input.expectedArch) throw new Error("WSL runtime architecture mismatch")
  if (basename(input.runtimePath) !== manifest.filename) throw new Error("WSL runtime path filename mismatch")

  const runtime = await readImmutableFile(input.runtimePath, "WSL runtime")
  if (runtime.byteLength !== manifest.bytes) throw new Error("WSL runtime bytes mismatch")
  const sha256 = createHash("sha256").update(runtime).digest("hex")
  if (sha256 !== manifest.sha256) throw new Error("WSL runtime SHA-256 mismatch")
  return Object.freeze({ ...manifest })
}

function safeLinuxPath(value: string, label: string) {
  if (!posix.isAbsolute(value) || /[\u0000\r\n]/u.test(value) || posix.normalize(value) !== value) {
    throw new Error(`${label} must be a canonical absolute Linux path`)
  }
  return value
}

function baseWslArgs(input: { selectedDisplayName: string; selectedUser: string }) {
  return ["--distribution", input.selectedDisplayName, "--user", input.selectedUser, "--exec"] as const
}

function oneLine(value: string, label: string) {
  const line = value.replace(/\r?\n$/u, "")
  if (!line || /[\u0000\r\n]/u.test(line)) throw new Error(`${label} returned malformed output`)
  return line
}

export async function installWslRuntime(input: {
  wslExecutable: string
  execute: WslExecute
  selectedDisplayName: string
  selectedUser: string
  selectedUid: number
  home: string
  channel: string
  runtimeSourceLinuxPath: string
  manifest: WslRuntimeManifest
}): Promise<InstalledWslRuntime> {
  if (!isSafeWslDisplayName(input.selectedDisplayName)) throw new Error("Invalid selected WSL distribution")
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(input.selectedUser)) throw new Error("Invalid selected WSL user")
  if (!Number.isSafeInteger(input.selectedUid) || input.selectedUid <= 0)
    throw new Error("Selected WSL user must be non-root")
  safeLinuxPath(input.home, "WSL home")
  safeLinuxPath(input.runtimeSourceLinuxPath, "WSL runtime source")
  const manifest = parseWslRuntimeManifest(input.manifest)
  if (posix.basename(input.runtimeSourceLinuxPath) !== manifest.filename) {
    throw new Error("WSL runtime source filename mismatch")
  }
  const bin = StoragePaths.resolve({
    channel: input.channel,
    platform: "linux",
    home: input.home,
    temp: "/tmp",
    env: {},
  }).bin
  const installedPath = posix.join(bin, manifest.filename)
  const prefix = baseWslArgs(input)

  await input.execute(input.wslExecutable, [...prefix, "/usr/bin/install", "--directory", "--mode=0700", "--", bin])
  await input.execute(input.wslExecutable, [
    ...prefix,
    "/usr/bin/install",
    "--mode=0500",
    "--",
    input.runtimeSourceLinuxPath,
    installedPath,
  ])
  const digest = oneLine(
    (await input.execute(input.wslExecutable, [...prefix, "/usr/bin/sha256sum", "--binary", "--", installedPath]))
      .stdout,
    "sha256sum",
  )
  if (digest !== `${manifest.sha256} *${installedPath}`) throw new Error("Installed WSL runtime SHA-256 mismatch")
  const bytes = oneLine(
    (await input.execute(input.wslExecutable, [...prefix, "/usr/bin/stat", "--format=%s", "--", installedPath])).stdout,
    "stat",
  )
  if (bytes !== String(manifest.bytes)) throw new Error("Installed WSL runtime bytes mismatch")
  return Object.freeze({ ...manifest, installedPath })
}
