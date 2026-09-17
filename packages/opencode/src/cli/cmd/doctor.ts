import { Database as BunDatabase } from "bun:sqlite"
import { Global } from "@opencode-ai/core/global"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Argv } from "yargs"

import { Database } from "@/storage/db"
import { withInitializedWalFiles } from "@/storage/wal-initialization"
import {
  diagnoseSchemaMarker,
  repairSchemaMarker,
  type ReleasedSchemaCandidate,
  type SchemaDatabase,
} from "@/storage/schema-marker"
import { activateMigration, prepareMigration, startFresh, type StartFreshReason } from "@/migration/cutover"
import { fingerprintMigrationSource } from "@/migration/capture"
import { readMigrationJournal } from "@/migration/journal"
import { discoverMigrationSources, type MigrationSource } from "@/migration/source"
import { cmd } from "./cmd"

export type SourceChoice = { id: string; label: string; contentFingerprint: string }
export type RecoveryCommandResult =
  | { state: "ready" }
  | { state: "choose-source"; sources: readonly SourceChoice[] }
  | { state: "retry"; operationID: string }
  | { state: "start-fresh"; reason: StartFreshReason }
  | {
      state: "marker-repair"
      diagnosis: "missing" | "invalid" | "unreadable" | "permission-invalid" | "schema-mismatch"
      inferredVersion?: string
    }
  | { state: "blocked"; reason: "corrupt" | "incompatible" | "destination-mutated" }

export type RecoveryCommandAction =
  | { type: "choose-source"; id: string; contentFingerprint: string }
  | { type: "retry"; operationID: string }
  | { type: "start-fresh"; confirmed: boolean }
  | { type: "repair-marker"; confirmed: boolean }

export type RecoveryControllerInput = {
  initialize?: boolean
  platform: "linux" | "darwin" | "win32"
  home: string
  env: Readonly<Record<string, string | undefined>>
  destination: { data: string; config: string; state: string; database: string; storage: string }
  candidates: readonly ReleasedSchemaCandidate[]
  open: (path: string, options: { readonly: boolean }) => SchemaDatabase
}

export class RecoveryCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeRecoveryCommandError"
  }
}

export function createRecoveryController(input: RecoveryControllerInput) {
  const inspect = async (): Promise<RecoveryCommandResult> => {
    const journal = await readMigrationJournal(input.destination.state)
    if (journal && journal.phase !== "complete") return { state: "retry", operationID: journal.operationID }
    if (journal?.phase === "complete") {
      if (journal.destinationFingerprint !== destinationFingerprint(input.destination)) {
        return { state: "blocked", reason: "destination-mutated" }
      }
      if (journal.sourceID === "start-fresh" && !(await fileExists(input.destination.database))) {
        return { state: "ready" }
      }
    }
    if (await fileExists(input.destination.database)) {
      if (input.initialize && (input.platform === "darwin" || input.platform === "linux")) {
        return withInitializedWalFiles(input.destination.database, () => inspectMarker(input))
      }
      return inspectMarker(input)
    }
    if (journal?.phase === "complete") {
      return (await completedExpectedDatabase(input, journal.snapshotDigest))
        ? { state: "blocked", reason: "destination-mutated" }
        : { state: "ready" }
    }

    const sources = await safeSources(input)
    if (sources.length === 0) return { state: "start-fresh", reason: "no-source" }
    const choices = await Promise.allSettled(
      sources.map(async (source) => ({
        id: source.id,
        label: source.label,
        contentFingerprint: await fingerprintMigrationSource(source),
      })),
    )
    const valid = choices.flatMap((choice) => (choice.status === "fulfilled" ? [choice.value] : []))
    if (valid.length === 0) return { state: "start-fresh", reason: "ambiguous" }
    return {
      state: "choose-source",
      sources: valid,
    }
  }

  const run = async (action: RecoveryCommandAction): Promise<RecoveryCommandResult> => {
    if (action.type === "repair-marker") {
      if (!action.confirmed) throw new RecoveryCommandError("Database marker repair requires explicit confirmation.")
      const repaired = repairSchemaMarker({
        databasePath: input.destination.database,
        candidates: input.candidates,
        open: input.open,
        confirmed: true,
      })
      if (repaired.state === "failed") return markerResult(repaired.diagnosis)
      return inspect()
    }
    if (action.type === "start-fresh") {
      if (!action.confirmed) throw new RecoveryCommandError("Start Fresh requires explicit confirmation.")
      const current = await inspect()
      if (current.state === "ready") return current
      const reason = current.state === "start-fresh" ? current.reason : recoveryReason(current)
      await startFresh({ destination: input.destination, reason, confirmed: true })
      return inspect()
    }
    if (action.type === "retry") {
      const current = await inspect()
      if (current.state === "ready") return current
      await activateMigration({ operationID: action.operationID, destination: input.destination })
      return inspect()
    }

    const sources = await safeSources(input)
    const prepared = await prepareMigration({
      sources,
      choice: { id: action.id, contentFingerprint: action.contentFingerprint },
      destination: input.destination,
    })
    if (prepared.type === "choose-source") return { state: "choose-source", sources: prepared.sources }
    if (prepared.type === "retry") return { state: "retry", operationID: prepared.operationID }
    if (prepared.type === "start-fresh") return { state: "start-fresh", reason: prepared.reason }
    await activateMigration({ operationID: prepared.operationID, destination: input.destination })
    return inspect()
  }

  return { inspect, run }
}

export function createDefaultRecoveryController(options: { initialize?: boolean } = {}) {
  return createRecoveryController({
    initialize: options.initialize,
    platform: process.platform as "linux" | "darwin" | "win32",
    home: Global.Path.home,
    env: process.env,
    destination: {
      data: Global.Path.data,
      config: Global.Path.config,
      state: Global.Path.recovery,
      database: Global.Path.database,
      storage: Global.Path.storage,
    },
    candidates: Database.releasedSchemaCandidates(),
    open: openSchemaDatabase,
  })
}

export function parseRecoveryCommandResult(raw: string): RecoveryCommandResult {
  try {
    return parseResult(JSON.parse(raw.trim()))
  } catch (error) {
    if (error instanceof RecoveryCommandError) throw error
    throw new RecoveryCommandError("The BharatCode CLI returned an invalid recovery result.")
  }
}

const DoctorRepairCommand = cmd({
  command: "repair",
  describe: "repair a compatible BharatCode database schema marker",
  builder: (yargs: Argv) =>
    yargs
      .option("confirm", {
        type: "boolean",
        default: false,
        describe: "confirm marker-only repair in noninteractive use",
      })
      .option("json", { type: "boolean", default: false, hidden: true }),
  handler: async (args: { confirm: boolean }) => {
    writeResult(await createDefaultRecoveryController().run({ type: "repair-marker", confirmed: args.confirm }))
  },
})

const DoctorStatusCommand = cmd({
  command: "$0",
  describe: "diagnose BharatCode migration and database recovery state without changing it",
  handler: async () => writeResult(await createDefaultRecoveryController().inspect()),
})

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose and repair BharatCode recovery state",
  builder: (yargs: Argv) => yargs.command(DoctorStatusCommand).command(DoctorRepairCommand),
  handler: () => {},
})

const RecoveryStatusCommand = cmd({
  command: "status",
  builder: (yargs: Argv) =>
    yargs
      .option("json", { type: "boolean", default: false, hidden: true })
      .option("initialize", { type: "boolean", default: false, hidden: true }),
  handler: async (args: { initialize: boolean }) =>
    writeResult(await createDefaultRecoveryController({ initialize: args.initialize }).inspect()),
})

const RecoveryChooseCommand = cmd({
  command: "choose-source",
  builder: (yargs: Argv) =>
    yargs
      .option("id", { type: "string", demandOption: true })
      .option("content-fingerprint", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false, hidden: true }),
  handler: async (args: { id: string; contentFingerprint: string }) =>
    writeResult(
      await createDefaultRecoveryController().run({
        type: "choose-source",
        id: args.id,
        contentFingerprint: args.contentFingerprint,
      }),
    ),
})

const RecoveryRetryCommand = cmd({
  command: "retry",
  builder: (yargs: Argv) =>
    yargs
      .option("operation-id", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false, hidden: true }),
  handler: async (args: { operationId: string }) =>
    writeResult(
      await createDefaultRecoveryController().run({ type: "retry", operationID: requireUUID(args.operationId) }),
    ),
})

const RecoveryFreshCommand = cmd({
  command: "start-fresh",
  builder: (yargs: Argv) =>
    yargs
      .option("confirm", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false, hidden: true }),
  handler: async (args: { confirm: boolean }) =>
    writeResult(await createDefaultRecoveryController().run({ type: "start-fresh", confirmed: args.confirm })),
})

export const RecoveryCommand = cmd({
  command: "recovery",
  describe: "resume or explicitly initialize BharatCode migration",
  builder: (yargs: Argv) =>
    yargs
      .command(RecoveryStatusCommand)
      .command(RecoveryChooseCommand)
      .command(RecoveryRetryCommand)
      .command(RecoveryFreshCommand)
      .demandCommand(),
  handler: () => {},
})

function inspectMarker(input: RecoveryControllerInput): RecoveryCommandResult {
  return markerResult(
    diagnoseSchemaMarker({
      databasePath: input.destination.database,
      candidates: input.candidates,
      open: input.open,
    }),
  )
}

function markerResult(diagnosis: ReturnType<typeof diagnoseSchemaMarker>): RecoveryCommandResult {
  if (diagnosis.state === "healthy") return { state: "ready" }
  if (diagnosis.state === "corrupt") return { state: "blocked", reason: "corrupt" }
  if (diagnosis.state === "schema-mismatch" && !diagnosis.inferredVersion) {
    return { state: "blocked", reason: "incompatible" }
  }
  return {
    state: "marker-repair",
    diagnosis: diagnosis.state,
    ...(diagnosis.inferredVersion ? { inferredVersion: diagnosis.inferredVersion } : {}),
  }
}

async function safeSources(input: RecoveryControllerInput): Promise<readonly MigrationSource[]> {
  const sources = await discoverMigrationSources({
    platform: input.platform,
    home: input.home,
    env: input.env,
    destinationRoots: [],
  })
  const destinationRoots = [input.destination.data, input.destination.config, input.destination.state]
  return sources.filter((source) => {
    const roots = Object.values(source.roots).filter((root): root is string => typeof root === "string")
    const exactDestination =
      roots.length > 0 && roots.every((root) => destinationRoots.some((item) => samePath(root, item)))
    if (exactDestination) return false
    if (roots.some((root) => destinationRoots.some((item) => pathsOverlap(root, item)))) {
      throw new RecoveryCommandError("A migration source overlapped the BharatCode destination.")
    }
    return true
  })
}

function parseResult(value: unknown): RecoveryCommandResult {
  if (!record(value) || typeof value.state !== "string") invalid()
  if (value.state === "ready") {
    exactKeys(value, ["state"])
    return { state: "ready" }
  }
  if (value.state === "retry") {
    exactKeys(value, ["state", "operationID"])
    return { state: "retry", operationID: requireUUID(value.operationID) }
  }
  if (value.state === "start-fresh") {
    exactKeys(value, ["state", "reason"])
    if (!isFreshReason(value.reason)) invalid()
    return { state: "start-fresh", reason: value.reason }
  }
  if (value.state === "blocked") {
    exactKeys(value, ["state", "reason"])
    if (value.reason !== "corrupt" && value.reason !== "incompatible" && value.reason !== "destination-mutated")
      invalid()
    return { state: "blocked", reason: value.reason }
  }
  if (value.state === "marker-repair") {
    exactKeys(
      value,
      value.inferredVersion === undefined ? ["state", "diagnosis"] : ["state", "diagnosis", "inferredVersion"],
    )
    if (!isMarkerRepairState(value.diagnosis)) invalid()
    if (value.inferredVersion !== undefined && !safeToken(value.inferredVersion, 128)) invalid()
    return {
      state: "marker-repair",
      diagnosis: value.diagnosis,
      ...(typeof value.inferredVersion === "string" ? { inferredVersion: value.inferredVersion } : {}),
    }
  }
  if (value.state !== "choose-source") invalid()
  exactKeys(value, ["state", "sources"])
  if (!Array.isArray(value.sources) || value.sources.length > 16) invalid()
  const sources = value.sources.map((source) => {
    if (!record(source)) invalid()
    exactKeys(source, ["id", "label", "contentFingerprint"])
    if (!safeToken(source.id, 160) || !safeLabel(source.label) || !digest(source.contentFingerprint)) invalid()
    return { id: source.id, label: source.label, contentFingerprint: source.contentFingerprint }
  })
  return { state: "choose-source", sources }
}

function writeResult(result: RecoveryCommandResult) {
  process.stdout.write(`${JSON.stringify(parseResult(result))}\n`)
}

/**
 * Why startup cannot continue, or undefined when it can.
 *
 * Only the destination's own integrity blocks startup. States that merely mean
 * "no usable database yet" are not failures: startup resolves them itself, by
 * adopting a single unambiguous source or initializing a clean destination.
 * Blocking on those bricked fresh installs, which report
 * `start-fresh`/`no-source` with nothing to migrate and nothing to lose.
 */
export function startupRecoveryBlocker(result: RecoveryCommandResult): string | undefined {
  if (result.state === "retry")
    return `A previous BharatCode migration was interrupted. Finish it with \`bharatcode recovery retry --operation-id ${result.operationID}\`.`
  if (result.state === "marker-repair")
    return `BharatCode's database marker needs repair (${result.diagnosis}). Run \`bharatcode doctor repair --confirm\`.`
  if (result.state === "blocked")
    return `BharatCode cannot use its database (${result.reason}). Run \`bharatcode doctor\` for details.`
  return undefined
}

export type StartupRecovery = {
  /** Previous-version data adopted without asking, because it was the only candidate. */
  adopted?: SourceChoice
  /** Candidates left alone because the choice was ambiguous. */
  deferredSources: readonly SourceChoice[]
}

/**
 * Resolve recovery state before startup.
 *
 * A single unambiguous source is adopted silently: there is exactly one
 * possible answer, so asking only strands the user's data behind a prompt.
 * Anything ambiguous starts clean and leaves every candidate untouched.
 */
export async function ensureStartupRecovery(): Promise<StartupRecovery> {
  const controller = createDefaultRecoveryController({ initialize: true })
  const current = await controller.inspect()
  if (current.state === "ready") return { deferredSources: [] }
  const blocker = startupRecoveryBlocker(current)
  if (blocker) throw new Error(blocker)

  const only = current.state === "choose-source" && current.sources.length === 1 ? current.sources[0]! : undefined
  if (only) {
    let result = await controller.run({
      type: "choose-source",
      id: only.id,
      contentFingerprint: only.contentFingerprint,
    })
    // A concurrent startup may already own the migration; finish it rather than racing.
    if (result.state === "retry") result = await controller.run({ type: "retry", operationID: result.operationID })
    if (result.state === "ready") return { adopted: only, deferredSources: [] }
    throw new Error(
      startupRecoveryBlocker(result) ??
        "BharatCode could not import data from a previous version. Run `bharatcode doctor` for details.",
    )
  }

  const deferredSources = current.state === "choose-source" ? current.sources : []
  const started = await controller.run({ type: "start-fresh", confirmed: true })
  if (started.state !== "ready") {
    throw new Error(
      startupRecoveryBlocker(started) ?? "BharatCode could not initialize its data directory. Run `bharatcode doctor`.",
    )
  }
  return { deferredSources }
}

function openSchemaDatabase(file: string, options: { readonly: boolean }): SchemaDatabase {
  const database = new BunDatabase(file, options)
  return {
    rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
    close: () => database.close(),
  }
}

function recoveryReason(result: RecoveryCommandResult): StartFreshReason {
  if (result.state === "retry") return "interrupted"
  if (result.state === "marker-repair" || result.state === "blocked") return "invalid-marker"
  if (result.state === "choose-source") return "ambiguous"
  return "no-source"
}

function destinationFingerprint(destination: RecoveryControllerInput["destination"]) {
  return createHash("sha256")
    .update(
      [destination.data, destination.config, destination.state, destination.database, destination.storage]
        .map((item) => path.resolve(item))
        .join("\0"),
    )
    .digest("hex")
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right)
}

function pathsOverlap(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  const relative = path.relative(a, b)
  const reverse = path.relative(b, a)
  return (
    a === b ||
    (!relative.startsWith("..") && !path.isAbsolute(relative)) ||
    (!reverse.startsWith("..") && !path.isAbsolute(reverse))
  )
}

function fileExists(file: string) {
  return Bun.file(file).exists()
}

async function completedExpectedDatabase(input: RecoveryControllerInput, snapshotDigest: string) {
  if (!/^[0-9a-f]{64}$/.test(snapshotDigest)) return true
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(input.destination.state, "migration-snapshots", snapshotDigest, "manifest.json"),
        "utf8",
      ),
    )
    return (
      record(manifest) &&
      Array.isArray(manifest.entries) &&
      manifest.entries.some((entry) => record(entry) && entry.relative === "database/main.sqlite")
    )
  } catch {
    return true
  }
}

function requireUUID(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    invalid()
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).toSorted()
  const expected = [...keys].toSorted()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid()
}

function safeToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n\\/]/.test(value)
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\0\r\n\\/]/.test(value)
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function isFreshReason(value: unknown): value is StartFreshReason {
  return value === "no-source" || value === "ambiguous" || value === "interrupted" || value === "invalid-marker"
}

function isMarkerRepairState(
  value: unknown,
): value is "missing" | "invalid" | "unreadable" | "permission-invalid" | "schema-mismatch" {
  return (
    value === "missing" ||
    value === "invalid" ||
    value === "unreadable" ||
    value === "permission-invalid" ||
    value === "schema-mismatch"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function invalid(): never {
  throw new RecoveryCommandError("The BharatCode CLI returned an invalid recovery result.")
}
