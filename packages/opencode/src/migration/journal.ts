import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises"
import path from "node:path"

export type MigrationPhase = "captured" | "prepared" | "activated" | "validated" | "complete" | "starting-fresh"

export type MigrationJournal = {
  version: 1
  operationID: string
  phase: MigrationPhase
  sourceID: string
  contentFingerprint: string
  snapshotDigest: string
  destinationFingerprint: string
  artifacts: readonly string[]
}

export type AdvanceInput = {
  stateRoot: string
  expected: MigrationJournal | undefined
  next: MigrationJournal
}

const FILENAME = "lean-migration-v1.json"
const MAX_BYTES = 65_536
const KEYS = [
  "version",
  "operationID",
  "phase",
  "sourceID",
  "contentFingerprint",
  "snapshotDigest",
  "destinationFingerprint",
  "artifacts",
] as const
const PHASES: readonly MigrationPhase[] = ["captured", "prepared", "activated", "validated", "complete", "starting-fresh"]

export class MigrationJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeMigrationJournalError"
  }
}

export async function readMigrationJournal(stateRoot: string): Promise<MigrationJournal | undefined> {
  const file = path.join(stateRoot, FILENAME)
  const info = await lstat(file).catch((error) => {
    if (nodeError(error, "ENOENT")) return undefined
    throw new MigrationJournalError("BharatCode could not inspect its migration journal.")
  })
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink()) throw new MigrationJournalError("The migration journal was not a regular file.")
  if (info.size > MAX_BYTES) throw new MigrationJournalError("The migration journal was too large.")
  const bytes = await readFile(file)
  if (bytes.byteLength > MAX_BYTES) throw new MigrationJournalError("The migration journal was too large.")
  try {
    return parseJournal(JSON.parse(new TextDecoder().decode(bytes)))
  } catch (error) {
    if (error instanceof MigrationJournalError) throw error
    throw new MigrationJournalError("The migration journal was invalid.")
  }
}

export async function advanceMigrationJournal(input: AdvanceInput): Promise<MigrationJournal> {
  const current = await readMigrationJournal(input.stateRoot)
  if (canonical(current) !== canonical(input.expected)) throw new MigrationJournalError("The migration journal changed.")
  const next = parseJournal(input.next)
  if (!canStart(current?.phase, next.phase)) throw new MigrationJournalError("The migration journal transition was invalid.")
  if (current && !sameOperation(current, next)) throw new MigrationJournalError("The migration journal identity changed.")
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
  await chmod(input.stateRoot, 0o700)
  const temporary = path.join(input.stateRoot, `.${FILENAME}.${randomUUID()}`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(canonical(next))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path.join(input.stateRoot, FILENAME))
  await syncDirectory(input.stateRoot)
  return next
}

export function canAdvanceMigrationJournal(from: MigrationPhase, to: MigrationPhase): boolean {
  if (to === "starting-fresh") return from !== "complete" && from !== "starting-fresh"
  return (
    (from === "captured" && to === "prepared") ||
    (from === "prepared" && to === "activated") ||
    (from === "activated" && to === "validated") ||
    (from === "validated" && to === "complete") ||
    (from === "starting-fresh" && to === "complete")
  )
}

function canStart(from: MigrationPhase | undefined, to: MigrationPhase) {
  if (!from) return to === "captured" || to === "starting-fresh"
  return canAdvanceMigrationJournal(from, to)
}

function parseJournal(value: unknown): MigrationJournal {
  if (!record(value)) throw new MigrationJournalError("The migration journal was invalid.")
  const keys = Object.keys(value).toSorted()
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== [...KEYS].toSorted()[index])) {
    throw new MigrationJournalError("The migration journal contained unknown fields.")
  }
  if (value.version !== 1) throw new MigrationJournalError("The migration journal version was invalid.")
  if (typeof value.phase !== "string" || !PHASES.includes(value.phase as MigrationPhase)) {
    throw new MigrationJournalError("The migration journal phase was invalid.")
  }
  if (typeof value.operationID !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationID)) {
    throw new MigrationJournalError("The migration journal operation ID was invalid.")
  }
  if (typeof value.sourceID !== "string" || value.sourceID.length < 1 || value.sourceID.length > 160) {
    throw new MigrationJournalError("The migration journal source ID was invalid.")
  }
  for (const field of ["contentFingerprint", "snapshotDigest", "destinationFingerprint"] as const) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field])) {
      throw new MigrationJournalError("The migration journal digest was invalid.")
    }
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.every((item) => typeof item === "string" && safeArtifact(item))) {
    throw new MigrationJournalError("The migration journal artifact provenance was invalid.")
  }
  if (new Set(value.artifacts).size !== value.artifacts.length) {
    throw new MigrationJournalError("The migration journal contained duplicate artifacts.")
  }
  return value as MigrationJournal
}

function sameOperation(left: MigrationJournal, right: MigrationJournal) {
  return (
    left.operationID === right.operationID &&
    left.sourceID === right.sourceID &&
    left.contentFingerprint === right.contentFingerprint &&
    left.snapshotDigest === right.snapshotDigest &&
    left.destinationFingerprint === right.destinationFingerprint &&
    left.artifacts.every((artifact) => right.artifacts.includes(artifact))
  )
}

function safeArtifact(value: string) {
  return value.length > 0 && value.length <= 512 && !path.isAbsolute(value) && !value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
}

function canonical(value: MigrationJournal | undefined) {
  if (!value) return ""
  return JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, value[key]])))
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

export * as MigrationJournalStore from "./journal"
