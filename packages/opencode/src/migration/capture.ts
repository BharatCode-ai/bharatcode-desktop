import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"

import { sanitizeMigrationRecord } from "./sanitize"
import type { MigrationSource } from "./source"

export type CapturedSource = {
  sourceID: string
  contentFingerprint: string
  snapshotDigest: string
  snapshotDirectory: string
  records: number
}

export type MigrationDestination = {
  data: string
  config: string
  state: string
  database: string
  storage: string
}

type CapturedEntry = { relative: string; bytes: Uint8Array; digest: string; size: number }
type Manifest = {
  version: 1
  contentFingerprint: string
  entries: readonly { relative: string; digest: string; size: number }[]
}

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_FILES = 50_000

export class MigrationCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeMigrationCaptureError"
  }
}

export async function captureMigrationSource(
  source: MigrationSource,
  destination: MigrationDestination,
): Promise<CapturedSource> {
  const entries = await scanSource(source)
  const contentFingerprint = fingerprint(entries)
  const manifest = manifestBytes(contentFingerprint, entries)
  const snapshotDigest = digest(manifest)
  const parent = path.join(destination.state, "migration-snapshots")
  const snapshotDirectory = path.join(parent, snapshotDigest)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const staging = path.join(parent, `.capture-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    for (const entry of entries) await writeDurable(path.join(staging, "records", entry.relative), entry.bytes)
    await writeDurable(path.join(staging, "manifest.json"), manifest)
    await syncDirectory(staging)
    const current = await scanSource(source)
    if (fingerprint(current) !== contentFingerprint) {
      throw new MigrationCaptureError("The migration source changed while BharatCode was sealing it.")
    }
    await rename(staging, snapshotDirectory).catch(async (error) => {
      if (!nodeError(error, "EEXIST") && !nodeError(error, "ENOTEMPTY")) throw error
      if (!(await snapshotMatches(snapshotDirectory, snapshotDigest))) {
        throw new MigrationCaptureError("A migration snapshot collision failed verification.")
      }
      await rm(staging, { recursive: true })
    })
    await syncDirectory(parent)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (error instanceof MigrationCaptureError) throw error
    throw new MigrationCaptureError("BharatCode could not durably seal the migration source.")
  }
  return { sourceID: source.id, contentFingerprint, snapshotDigest, snapshotDirectory, records: entries.length }
}

export async function fingerprintMigrationSource(source: MigrationSource) {
  return fingerprint(await scanSource(source))
}

export async function verifyCapturedSnapshot(input: {
  snapshotDirectory: string
  snapshotDigest: string
  contentFingerprint: string
}) {
  if (!(await snapshotMatches(input.snapshotDirectory, input.snapshotDigest))) return false
  const manifest = JSON.parse(await readFile(path.join(input.snapshotDirectory, "manifest.json"), "utf8")) as Manifest
  return manifest.contentFingerprint === input.contentFingerprint
}

export async function verifyCapturedSource(input: { captured: CapturedSource; source: MigrationSource }): Promise<boolean> {
  try {
    if (input.captured.sourceID !== input.source.id) return false
    if (fingerprint(await scanSource(input.source)) !== input.captured.contentFingerprint) return false
    return snapshotMatches(input.captured.snapshotDirectory, input.captured.snapshotDigest)
  } catch {
    return false
  }
}

async function scanSource(source: MigrationSource) {
  const entries = (
    await Promise.all(
      Object.entries(source.roots).map(async ([role, root]) => (root ? scanDirectory(role, root) : Promise.resolve([]))),
    )
  )
    .flat()
    .toSorted((left, right) => left.relative.localeCompare(right.relative))
  if (entries.length > MAX_FILES || entries.reduce((total, entry) => total + entry.size, 0) > MAX_TOTAL_BYTES) {
    throw new MigrationCaptureError("The migration source exceeded its capture budget.")
  }
  return entries
}

async function scanDirectory(role: string, root: string): Promise<CapturedEntry[]> {
  const result: CapturedEntry[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const names = (await readdir(directory)).toSorted()
    for (const name of names) {
      const absolute = path.join(directory, name)
      const relative = prefix ? path.posix.join(prefix, name) : name
      const before = await lstat(absolute)
      if (before.isSymbolicLink()) throw new MigrationCaptureError("A migration source contained an unsupported link.")
      if (before.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (!before.isFile()) throw new MigrationCaptureError("A migration source contained an unsupported entry.")
      if (before.size > MAX_FILE_BYTES) throw new MigrationCaptureError("A migration source file exceeded its capture budget.")
      const bytes = await readFile(absolute)
      const after = await lstat(absolute)
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new MigrationCaptureError("The migration source changed during capture.")
      }
      const sanitized = sanitizeBytes(role, relative, bytes)
      const capturedRelative = path.posix.join(role, relative)
      result.push({ relative: capturedRelative, bytes: sanitized, digest: digest(sanitized), size: sanitized.byteLength })
    }
  }
  await visit(root, "")
  return result
}

function sanitizeBytes(role: string, relative: string, bytes: Uint8Array) {
  if (!/\.(?:json|jsonc|dat)$/i.test(relative)) return bytes
  const text = new TextDecoder().decode(bytes)
  const value = JSON.parse(text) as unknown
  const kind = role === "config" ? (path.basename(relative).startsWith("tui.") ? "tui" : "config") : role === "desktop" ? "desktop" : relative.includes("project") ? "project" : "session"
  return new TextEncoder().encode(JSON.stringify(sanitizeMigrationRecord({ kind, value }).value))
}

function fingerprint(entries: readonly CapturedEntry[]) {
  return createHash("sha256")
    .update(entries.map((entry) => `${entry.relative}\0${entry.size}\0${entry.digest}`).join("\0"))
    .digest("hex")
}

function manifestBytes(contentFingerprint: string, entries: readonly CapturedEntry[]) {
  const manifest: Manifest = {
    version: 1,
    contentFingerprint,
    entries: entries.map((entry) => ({ relative: entry.relative, digest: entry.digest, size: entry.size })),
  }
  return new TextEncoder().encode(JSON.stringify(manifest))
}

async function snapshotMatches(directory: string, expectedDigest: string) {
  const bytes = await readFile(path.join(directory, "manifest.json"))
  if (digest(bytes) !== expectedDigest) return false
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) return false
  for (const entry of manifest.entries) {
    if (!safeRelative(entry.relative)) return false
    const record = await readFile(path.join(directory, "records", entry.relative))
    if (record.byteLength !== entry.size || digest(record) !== entry.digest) return false
  }
  return true
}

async function writeDurable(file: string, bytes: Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(file, 0o600)
  await syncDirectory(path.dirname(file))
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function safeRelative(value: string) {
  return value.length > 0 && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === "..")
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

export * as MigrationCapture from "./capture"
