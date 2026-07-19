import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"

import {
  captureMigrationSource,
  fingerprintMigrationSource,
  verifyCapturedSnapshot,
  type MigrationDestination,
} from "./capture"
import { advanceMigrationJournal, readMigrationJournal, type MigrationJournal } from "./journal"
import type { MigrationChoice, MigrationSource } from "./source"
import { withMigrationMaintenanceLock } from "../storage/migration-maintenance-lock"

export type RecoveryAction =
  | { type: "choose-source"; sources: readonly { id: string; label: string; contentFingerprint: string }[] }
  | { type: "retry"; operationID: string }
  | { type: "start-fresh"; reason: "no-source" | "ambiguous" | "interrupted" | "invalid-marker" }
export type PrepareMigrationInput = {
  sources: readonly MigrationSource[]
  choice?: MigrationChoice
  destination: MigrationDestination
}
export type ActivateMigrationInput = { operationID: string; destination: MigrationDestination }
export type StartFreshReason = "no-source" | "ambiguous" | "interrupted" | "invalid-marker"
export type StartFreshInput = { destination: MigrationDestination; reason: StartFreshReason; confirmed: true }

export class MigrationCutoverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeMigrationCutoverError"
  }
}

export async function prepareMigration(
  input: PrepareMigrationInput,
): Promise<RecoveryAction | { type: "prepared"; operationID: string }> {
  validateDestinationLayout(input.destination)
  return withMigrationMaintenanceLock(path.dirname(input.destination.database), async () => {
    const existing = await readMigrationJournal(input.destination.state)
    if (existing) return { type: "retry", operationID: existing.operationID }
    if (input.sources.length === 0) return { type: "start-fresh", reason: "no-source" }
    const choices = (
      await Promise.all(
        input.sources.map(async (source) => ({
          id: source.id,
          label: source.label,
          contentFingerprint: await fingerprintMigrationSource(source),
        })),
      )
    ).toSorted((left, right) => left.id.localeCompare(right.id))
    const selected = input.choice
      ? input.sources.find(
          (source) =>
            source.id === input.choice?.id &&
            choices.find((choice) => choice.id === source.id)?.contentFingerprint === input.choice.contentFingerprint,
        )
      : input.sources.length === 1
        ? input.sources[0]
        : undefined
    if (!selected) return { type: "choose-source", sources: choices }
    const captured = await captureMigrationSource(selected, input.destination)
    const operationID = randomUUID()
    const journal: MigrationJournal = {
      version: 1,
      operationID,
      phase: "captured",
      sourceID: selected.id,
      contentFingerprint: captured.contentFingerprint,
      snapshotDigest: captured.snapshotDigest,
      destinationFingerprint: destinationFingerprint(input.destination),
      artifacts: [`migration-snapshots/${captured.snapshotDigest}`],
    }
    await advanceMigrationJournal({ stateRoot: input.destination.state, expected: undefined, next: journal })
    await advanceMigrationJournal({
      stateRoot: input.destination.state,
      expected: journal,
      next: { ...journal, phase: "prepared" },
    })
    return { type: "prepared", operationID }
  })
}

export async function activateMigration(
  input: ActivateMigrationInput,
): Promise<{ state: "complete"; sourceID: string }> {
  validateDestinationLayout(input.destination)
  return withMigrationMaintenanceLock(path.dirname(input.destination.database), async () => {
    let journal = await readMigrationJournal(input.destination.state)
    if (!journal || journal.operationID !== input.operationID) {
      throw new MigrationCutoverError("The requested migration operation was not available.")
    }
    if (journal.destinationFingerprint !== destinationFingerprint(input.destination)) {
      throw new MigrationCutoverError("The migration destination changed.")
    }
    if (journal.phase === "complete") return { state: "complete", sourceID: journal.sourceID }
    if (!(await verifyCapturedSnapshot(snapshotInput(journal, input.destination)))) {
      throw new MigrationCutoverError("The sealed migration snapshot failed verification.")
    }
    if (journal.phase === "prepared") {
      await activateSnapshot(journal, input.destination)
      const next = {
        ...journal,
        phase: "activated" as const,
        artifacts: [...journal.artifacts, `migration-staging/${journal.operationID}`],
      }
      journal = await advanceMigrationJournal({ stateRoot: input.destination.state, expected: journal, next })
    }
    if (journal.phase === "activated") {
      if (!(await validateFreshDestination(input.destination))) {
        throw new MigrationCutoverError("The activated migration destination failed validation.")
      }
      journal = await advanceMigrationJournal({
        stateRoot: input.destination.state,
        expected: journal,
        next: { ...journal, phase: "validated" },
      })
    }
    if (journal.phase === "validated") {
      journal = await advanceMigrationJournal({
        stateRoot: input.destination.state,
        expected: journal,
        next: { ...journal, phase: "complete" },
      })
    }
    if (journal.phase !== "complete") throw new MigrationCutoverError("The migration operation could not complete.")
    return { state: "complete", sourceID: journal.sourceID }
  })
}

export async function startFresh(input: StartFreshInput): Promise<{ state: "fresh"; quarantine?: string }> {
  if (input.confirmed !== true) throw new MigrationCutoverError("Start Fresh requires explicit confirmation.")
  validateDestinationLayout(input.destination)
  return withMigrationMaintenanceLock(path.dirname(input.destination.database), async () => {
    const existing = await readMigrationJournal(input.destination.state).catch(() => undefined)
    if (existing?.phase === "complete")
      throw new MigrationCutoverError("A healthy completed destination cannot Start Fresh.")
    await validateKnownDestinations(input.destination)
    if (await healthyDatabase(input.destination.database))
      throw new MigrationCutoverError("A healthy data-bearing destination cannot Start Fresh.")
    const operationID = randomUUID()
    const quarantine = path.join(input.destination.state, "migration-quarantine", operationID)
    const moved = await quarantinePartials(input.destination, quarantine)
    await Promise.all([
      mkdir(input.destination.data, { recursive: true, mode: 0o700 }),
      mkdir(input.destination.config, { recursive: true, mode: 0o700 }),
      mkdir(input.destination.state, { recursive: true, mode: 0o700 }),
      mkdir(input.destination.storage, { recursive: true, mode: 0o700 }),
    ])
    if (!(await freshDestinationIsEmpty(input.destination)))
      throw new MigrationCutoverError("Start Fresh could not produce an empty canonical destination.")
    const blank = "0".repeat(64)
    const journal: MigrationJournal = {
      version: 1,
      operationID,
      phase: "starting-fresh",
      sourceID: "start-fresh",
      contentFingerprint: blank,
      snapshotDigest: blank,
      destinationFingerprint: destinationFingerprint(input.destination),
      artifacts: moved ? [`migration-quarantine/${operationID}`] : [],
    }
    await advanceMigrationJournal({ stateRoot: input.destination.state, expected: undefined, next: journal })
    await advanceMigrationJournal({
      stateRoot: input.destination.state,
      expected: journal,
      next: { ...journal, phase: "complete" },
    })
    if (!(await validateFreshDestination(input.destination))) {
      throw new MigrationCutoverError("The fresh destination failed validation.")
    }
    return { state: "fresh", ...(moved ? { quarantine } : {}) }
  })
}

export async function validateFreshDestination(destination: MigrationDestination): Promise<boolean> {
  try {
    validateDestinationLayout(destination)
    for (const directory of [destination.data, destination.config, destination.state, destination.storage]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
    }
    if (await exists(destination.database)) {
      const database = new Database(destination.database, { readonly: true })
      try {
        const rows = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
        if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") return false
      } finally {
        database.close()
      }
    }
    return !(await configContainsForbiddenTarget(destination.config))
  } catch {
    return false
  }
}

async function activateSnapshot(journal: MigrationJournal, destination: MigrationDestination) {
  const staging = path.join(destination.state, "migration-staging", journal.operationID)
  const snapshot = path.join(destination.state, "migration-snapshots", journal.snapshotDigest)
  const records = path.join(snapshot, "records")
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const manifest = JSON.parse(await readFile(path.join(snapshot, "manifest.json"), "utf8")) as {
    entries: readonly { relative: string }[]
  }
  for (const entry of manifest.entries) {
    const target = path.join(staging, entry.relative)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, await readFile(path.join(records, entry.relative)), { mode: 0o600, flag: "wx" })
  }
  await moveRole(path.join(staging, "config"), destination.config)
  await moveRole(path.join(staging, "data"), destination.data)
  await moveFile(path.join(staging, "database", "main.sqlite"), destination.database)
  await moveRole(path.join(staging, "desktop"), path.join(destination.data, "desktop"))
  await Promise.all([
    mkdir(destination.config, { recursive: true, mode: 0o700 }),
    mkdir(destination.storage, { recursive: true, mode: 0o700 }),
  ])
}

async function moveRole(source: string, destination: string) {
  if (!(await exists(source))) return
  if (await exists(destination)) {
    const existing = await readdir(destination)
    if (await sameTree(source, destination)) {
      await rm(source, { recursive: true })
      return
    }
    if (existing.filter((name) => !name.startsWith("lean-migration-maintenance.sqlite")).length === 0) {
      for (const name of await readdir(source)) {
        const target = path.join(destination, name)
        if (await exists(target)) throw new MigrationCutoverError("The migration destination changed.")
        await rename(path.join(source, name), target)
      }
      await rm(source, { recursive: true })
      return
    }
    if (existing.length > 0) throw new MigrationCutoverError("The migration destination changed.")
    await rm(destination, { recursive: true })
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await rename(source, destination)
}

async function moveFile(source: string, destination: string) {
  if (!(await exists(source))) return
  if (await exists(destination)) {
    if (digestBytes(await readFile(source)) !== digestBytes(await readFile(destination)))
      throw new MigrationCutoverError("The migration destination changed.")
    await rm(source)
    return
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await rename(source, destination)
}

async function validateKnownDestinations(destination: MigrationDestination) {
  for (const item of [
    destination.data,
    destination.config,
    destination.state,
    destination.storage,
    destination.database,
  ]) {
    const info = await lstat(item).catch((error) => (nodeError(error, "ENOENT") ? undefined : Promise.reject(error)))
    if (info?.isSymbolicLink()) throw new MigrationCutoverError("A destination artifact was an unsupported link.")
    if (info?.isDirectory()) await assertNoLinks(item)
  }
}

async function quarantinePartials(destination: MigrationDestination, quarantine: string) {
  const present: { source: string; relative: string; sha256: string }[] = []
  if (await exists(destination.data)) {
    for (const name of await readdir(destination.data)) {
      if (name.startsWith("lean-migration-maintenance.sqlite")) continue
      const source = path.join(destination.data, name)
      present.push({ source, relative: path.posix.join("data", name), sha256: await digestArtifact(source) })
    }
  }
  if (await exists(destination.config))
    present.push({ source: destination.config, relative: "config", sha256: await digestArtifact(destination.config) })
  if (await exists(destination.state)) {
    for (const name of await readdir(destination.state)) {
      if (name === "migration-quarantine") continue
      const source = path.join(destination.state, name)
      present.push({ source, relative: path.posix.join("state", name), sha256: await digestArtifact(source) })
    }
  }
  if (present.length === 0) return false
  await mkdir(quarantine, { recursive: true, mode: 0o700 })
  for (const item of present) {
    const target = path.join(quarantine, item.relative)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await rename(item.source, target)
  }
  await writeFile(
    path.join(quarantine, "manifest.json"),
    JSON.stringify({ version: 1, artifacts: present.map(({ relative, sha256 }) => ({ relative, sha256 })) }),
    { mode: 0o600 },
  )
  await syncDirectory(quarantine)
  await syncDirectory(destination.state)
  return true
}

async function healthyDatabase(file: string) {
  if (!(await exists(file))) return false
  try {
    const database = new Database(file, { readonly: true })
    try {
      const rows = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
      return rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok"
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}

async function freshDestinationIsEmpty(destination: MigrationDestination) {
  const data = (await readdir(destination.data)).filter(
    (name) => name !== path.basename(destination.storage) && !name.startsWith("lean-migration-maintenance.sqlite"),
  )
  return (
    data.length === 0 &&
    (await readdir(destination.config)).length === 0 &&
    (await readdir(destination.storage)).length === 0
  )
}

async function sameTree(source: string, destination: string) {
  return (await treeIdentity(source, false)) === (await treeIdentity(destination, true))
}

async function treeIdentity(root: string, ignoreMaintenance: boolean) {
  const entries: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).toSorted()) {
      if (ignoreMaintenance && !prefix && name.startsWith("lean-migration-maintenance.sqlite")) continue
      const absolute = path.join(directory, name)
      const relative = prefix ? path.posix.join(prefix, name) : name
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new MigrationCutoverError("A destination artifact was an unsupported link.")
      if (info.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (!info.isFile()) throw new MigrationCutoverError("A destination artifact was unsupported.")
      entries.push(`${relative}\0${digestBytes(await readFile(absolute))}`)
    }
  }
  await visit(root, "")
  return createHash("sha256").update(entries.join("\0")).digest("hex")
}

async function assertNoLinks(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    const item = path.join(root, name)
    const info = await lstat(item)
    if (info.isSymbolicLink()) throw new MigrationCutoverError("A destination artifact was an unsupported link.")
    if (info.isDirectory()) await assertNoLinks(item)
  }
}

async function digestArtifact(item: string) {
  const info = await lstat(item)
  if (info.isSymbolicLink()) throw new MigrationCutoverError("A destination artifact was an unsupported link.")
  if (info.isFile()) return digestBytes(await readFile(item))
  if (!info.isDirectory()) throw new MigrationCutoverError("A destination artifact was unsupported.")
  return treeIdentity(item, false)
}

function digestBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function snapshotInput(journal: MigrationJournal, destination: MigrationDestination) {
  return {
    snapshotDirectory: path.join(destination.state, "migration-snapshots", journal.snapshotDigest),
    snapshotDigest: journal.snapshotDigest,
    contentFingerprint: journal.contentFingerprint,
  }
}

function destinationFingerprint(destination: MigrationDestination) {
  return createHash("sha256")
    .update(
      [destination.data, destination.config, destination.state, destination.database, destination.storage]
        .map((item) => path.resolve(item))
        .join("\0"),
    )
    .digest("hex")
}

function validateDestinationLayout(destination: MigrationDestination) {
  const [data, config, state, database, storage] = [
    destination.data,
    destination.config,
    destination.state,
    destination.database,
    destination.storage,
  ].map((item) => path.resolve(item))
  if ([data, config, state, database, storage].some((item) => !path.isAbsolute(item))) {
    throw new MigrationCutoverError("Migration destination paths must be absolute.")
  }
  if (overlaps(data, config) || overlaps(data, state) || overlaps(config, state)) {
    throw new MigrationCutoverError("Migration destination roots overlap.")
  }
  if (!descendant(data, database) || !descendant(data, storage) || overlaps(database, storage)) {
    throw new MigrationCutoverError("Migration destination roots overlap incorrectly.")
  }
}

async function configContainsForbiddenTarget(root: string): Promise<boolean> {
  for (const name of await readdir(root)) {
    const file = path.join(root, name)
    const info = await lstat(file)
    if (info.isSymbolicLink()) return true
    if (info.isDirectory()) {
      if (await configContainsForbiddenTarget(file)) return true
      continue
    }
    if (/\.(?:json|jsonc)$/i.test(name) && /opencode\.ai|opncd\.ai|models\.dev/i.test(await readFile(file, "utf8")))
      return true
  }
  return false
}

async function exists(value: string) {
  return lstat(value).then(
    () => true,
    (error) => (nodeError(error, "ENOENT") ? false : Promise.reject(error)),
  )
}

function descendant(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function overlaps(left: string, right: string) {
  return left === right || descendant(left, right) || descendant(right, left)
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

export * as MigrationCutover from "./cutover"
