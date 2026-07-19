import { Database as BunDatabase } from "bun:sqlite"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  createRecoveryController,
  parseRecoveryCommandResult,
  type RecoveryCommandResult,
  type RecoveryControllerInput,
} from "@/cli/cmd/doctor"
import { fingerprintMigrationSource, type MigrationDestination } from "@/migration/capture"
import { prepareMigration } from "@/migration/cutover"
import type { MigrationSource } from "@/migration/source"
import { releasedSchemaCandidatesFromMigrations, type SchemaDatabase } from "@/storage/schema-marker"
import { createStartupRecovery } from "../../../desktop/src/main/startup-recovery"

type Receipt = { scenario: 6 | 7; proof: string; assertions: number }
const receipts: Receipt[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

afterAll(() => {
  expect(receipts.some((receipt) => receipt.scenario === 6)).toBe(true)
  expect(receipts.some((receipt) => receipt.scenario === 7)).toBe(true)
  process.stdout.write(`${JSON.stringify({ type: "lean-migration-recovery-receipt", receipts })}\n`)
})

describe("lean next-beta migration and recovery scenarios 6-7", () => {
  test("explicitly chooses, sanitizes, preserves, repairs, restarts, and executes zero forbidden targets", async () => {
    const fixture = await databaseFixture()
    const sourceDatabase = path.join(fixture.home, ".local", "share", "opencode", "opencode.db")
    const sourceConfig = path.join(fixture.home, ".config", "opencode", "opencode.json")
    const sourceDatabaseBytes = await readFile(sourceDatabase)
    const sourceConfigBytes = await readFile(sourceConfig)
    const hostile = new ForbiddenTargetRecorder()
    await exerciseActiveTargets({ database: sourceDatabase, config: sourceConfig }, hostile)
    expect(hostile.total()).toBeGreaterThan(0)

    const controller = createRecoveryController(fixture.input)
    const status = await controller.inspect()
    expect(status.state).toBe("choose-source")
    if (status.state !== "choose-source") throw new Error("expected explicit source choice")
    expect(status.sources).toHaveLength(1)
    const selected = status.sources[0]!
    expect(
      await controller.run({ type: "choose-source", id: selected.id, contentFingerprint: selected.contentFingerprint }),
    ).toEqual({
      state: "marker-repair",
      diagnosis: "missing",
      inferredVersion: "fixture-v1",
    })
    expect(await controller.run({ type: "repair-marker", confirmed: true })).toEqual({ state: "ready" })

    expect(await readFile(sourceDatabase)).toEqual(sourceDatabaseBytes)
    expect(await readFile(sourceConfig)).toEqual(sourceConfigBytes)
    expect(JSON.parse(await readFile(path.join(fixture.destination.config, "opencode.json"), "utf8"))).toEqual({
      theme: "dark",
    })
    const activated = new BunDatabase(fixture.destination.database, { readonly: true })
    expect(activated.query("SELECT title, model FROM session").get()).toEqual({ title: "retained", model: null })
    expect(activated.query("SELECT data FROM message").get()).toEqual({
      data: '{"role":"assistant","text":"Harmless transcript: opencode serve uses https://opencode.ai"}',
    })
    expect(activated.query("SELECT count(*) AS count FROM permission").get()).toEqual({ count: 0 })
    activated.close()

    const recorder = new ForbiddenTargetRecorder()
    await exerciseActiveTargets(
      { database: fixture.destination.database, config: path.join(fixture.destination.config, "opencode.json") },
      recorder,
    )
    expect(recorder.receipt()).toEqual({ fetch: [], connect: [], spawn: [] })
    expect(await createRecoveryController(fixture.input).inspect()).toEqual({ state: "ready" })
    receipts.push({ scenario: 6, proof: "explicit-sanitized-preserved-restart-zero-targets", assertions: 13 })
  }, 20_000)

  test("rejects stale choices and exposes deterministic ambiguity without destination effects", async () => {
    const fixture = await configFixture()
    const controller = createRecoveryController(fixture.input)
    const first = await controller.inspect()
    if (first.state !== "choose-source") throw new Error("expected source choice")
    const original = first.sources[0]!
    const source = path.join(fixture.home, ".config", "opencode", "opencode.json")
    await writeFile(source, '{"theme":"light"}', { mode: 0o600 })
    const stale = await controller.run({
      type: "choose-source",
      id: original.id,
      contentFingerprint: original.contentFingerprint,
    })
    expect(stale.state).toBe("choose-source")
    expect(await Bun.file(fixture.destination.database).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.destination.state, "lean-migration-v1.json")).exists()).toBe(false)

    const desktop = path.join(fixture.home, ".bharatcode")
    await mkdir(desktop, { recursive: true, mode: 0o700 })
    await writeFile(path.join(desktop, "preferences.json"), '{"theme":"dark"}', { mode: 0o600 })
    const ambiguous = await controller.inspect()
    expect(ambiguous.state).toBe("choose-source")
    if (ambiguous.state !== "choose-source") throw new Error("expected ambiguity")
    expect(ambiguous.sources).toHaveLength(2)
    expect(ambiguous.sources.map((source) => source.id)).toEqual(
      ambiguous.sources.map((source) => source.id).toSorted(),
    )
    receipts.push({ scenario: 6, proof: "stale-choice-and-ambiguity", assertions: 6 })
  })

  test("Retry converges after the canonical database durable switch and rejects exact mutation", async () => {
    const convergent = await durableEdgeFixture("convergent")
    const prepared = await prepareMigration({ sources: [convergent.source], destination: convergent.destination })
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")
    await installThroughDatabaseSwitch(convergent.destination)
    const controller = createRecoveryController(convergent.input)
    expect(await controller.inspect()).toEqual({ state: "retry", operationID: prepared.operationID })
    expect(await controller.run({ type: "retry", operationID: prepared.operationID })).toMatchObject({
      state: "marker-repair",
      diagnosis: "missing",
    })
    expect(await controller.run({ type: "repair-marker", confirmed: true })).toEqual({ state: "ready" })

    const hostile = await durableEdgeFixture("hostile")
    const hostilePrepared = await prepareMigration({ sources: [hostile.source], destination: hostile.destination })
    if (hostilePrepared.type !== "prepared") throw new Error("expected prepared operation")
    await installThroughDatabaseSwitch(hostile.destination)
    const changed = new BunDatabase(hostile.destination.database)
    changed.run("UPDATE session SET title = 'mutated'")
    changed.close()
    await expect(
      createRecoveryController(hostile.input).run({ type: "retry", operationID: hostilePrepared.operationID }),
    ).rejects.toThrow("destination changed")
    receipts.push({ scenario: 7, proof: "post-database-switch-retry-and-mutation-rejection", assertions: 4 })
  }, 20_000)

  test("Start Fresh ignores marker bytes while compatible repair and incompatible refusal leave data untouched", async () => {
    const fresh = await configFixture()
    await writeFile(fresh.destination.database, "partial", { mode: 0o600 })
    await writeFile(path.join(fresh.destination.data, ".schema-version"), "hostile-marker", { mode: 0o000 })
    const freshController = createRecoveryController(fresh.input)
    expect(await freshController.inspect()).toEqual({ state: "blocked", reason: "corrupt" })
    expect(await freshController.run({ type: "repair-marker", confirmed: true })).toEqual({
      state: "blocked",
      reason: "corrupt",
    })
    expect(await readFile(fresh.destination.database, "utf8")).toBe("partial")
    expect(await freshController.run({ type: "start-fresh", confirmed: true })).toEqual({ state: "ready" })
    expect(await Bun.file(path.join(fresh.destination.data, ".schema-version")).exists()).toBe(false)
    expect(await Bun.file(path.join(fresh.home, ".config", "opencode", "opencode.json")).exists()).toBe(true)

    const compatible = await emptyFixture("compatible")
    createCompatibleDatabase(compatible.destination.database)
    const marker = path.join(compatible.destination.data, ".schema-version")
    await writeFile(marker, "broken", { mode: 0o600 })
    const before = await readFile(compatible.destination.database)
    const compatibleController = createRecoveryController(compatible.input)
    expect(await compatibleController.inspect()).toMatchObject({ state: "marker-repair", diagnosis: "invalid" })
    expect(await compatibleController.run({ type: "repair-marker", confirmed: true })).toEqual({ state: "ready" })
    expect(await readFile(compatible.destination.database)).toEqual(before)

    const incompatible = await emptyFixture("incompatible")
    const unknown = new BunDatabase(incompatible.destination.database, { create: true })
    unknown.run("CREATE TABLE unsupported(id TEXT PRIMARY KEY)")
    unknown.close()
    await writeFile(path.join(incompatible.destination.data, ".schema-version"), "broken", { mode: 0o600 })
    const incompatibleBytes = await readFile(incompatible.destination.database)
    const incompatibleController = createRecoveryController(incompatible.input)
    expect(await incompatibleController.inspect()).toEqual({ state: "blocked", reason: "incompatible" })
    expect(await incompatibleController.run({ type: "repair-marker", confirmed: true })).toEqual({
      state: "blocked",
      reason: "incompatible",
    })
    expect(await readFile(incompatible.destination.database)).toEqual(incompatibleBytes)
    receipts.push({
      scenario: 7,
      proof: "marker-independent-fresh-compatible-repair-incompatible-refusal",
      assertions: 13,
    })
  }, 20_000)

  test("real CLI and Desktop adapters expose identical closed choices and converge across processes", async () => {
    const fixture = await configFixture()
    const env = childEnvironment(fixture.home)
    const desktop = createStartupRecovery({
      executable: process.execPath,
      invoke: (_executable, args) => runCliRaw(env, args),
    })
    const cliStatus = parseRecoveryCommandResult(await runCliRaw(env, ["recovery", "status", "--json"]))
    const desktopStatus = await desktop.inspect()
    expect(desktopStatus).toEqual(cliStatus)
    if (cliStatus.state !== "choose-source") throw new Error("expected shared source choice")
    const selected = cliStatus.sources[0]!

    const [cliResult, desktopResult] = await Promise.all([
      runCli(env, [
        "recovery",
        "choose-source",
        "--id",
        selected.id,
        "--content-fingerprint",
        selected.contentFingerprint,
        "--json",
      ]),
      desktop.run({ type: "choose-source", id: selected.id, contentFingerprint: selected.contentFingerprint }),
    ])
    for (const result of [cliResult, desktopResult]) {
      if (result.state === "retry") {
        expect(await desktop.run({ type: "retry", operationID: result.operationID })).toEqual({ state: "ready" })
      } else {
        expect(result).toEqual({ state: "ready" })
      }
    }
    expect(await desktop.inspect()).toEqual({ state: "ready" })
    expect(parseRecoveryCommandResult(await runCliRaw(env, ["recovery", "status", "--json"]))).toEqual({
      state: "ready",
    })
    expect(await Bun.file(path.join(fixture.home, ".config", "opencode", "opencode.json")).exists()).toBe(true)
    receipts.push({ scenario: 7, proof: "real-cli-desktop-cross-process-convergence", assertions: 6 })
  }, 30_000)
})

class ForbiddenTargetRecorder {
  readonly fetch: string[] = []
  readonly connect: string[] = []
  readonly spawn: string[] = []

  record(key: string, value: string) {
    if (!/opencode\.ai|opncd\.ai|models\.dev|\bopencode(?:\.exe)?\b/i.test(value)) return
    if (/command|exec|binary|runtime/i.test(key)) this.recordSpawn(value)
    else if (/host|origin|endpoint|server/i.test(key)) this.recordConnect(value)
    else this.recordFetch(value)
  }

  recordFetch(value: string) {
    this.fetch.push(value)
  }

  recordConnect(value: string) {
    this.connect.push(value)
  }

  recordSpawn(value: string) {
    this.spawn.push(value)
  }

  total() {
    return this.fetch.length + this.connect.length + this.spawn.length
  }

  receipt() {
    return { fetch: this.fetch, connect: this.connect, spawn: this.spawn }
  }
}

async function exerciseActiveTargets(input: { database: string; config: string }, recorder: ForbiddenTargetRecorder) {
  const config = JSON.parse(await readFile(input.config, "utf8"))
  visitActive(config, recorder)
  const database = new BunDatabase(input.database, { readonly: true })
  try {
    for (const table of ["permission", "workspace"] as const) {
      if (!database.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue
      const columns = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
      for (const column of columns.filter((item) => item.name === "data" || item.name === "config")) {
        for (const row of database.query(`SELECT ${column.name} AS value FROM ${table}`).all() as { value: string }[]) {
          visitActive(JSON.parse(row.value), recorder)
        }
      }
    }
    if (database.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='session'").get()) {
      for (const row of database.query("SELECT model FROM session WHERE model IS NOT NULL").all() as {
        model: string
      }[]) {
        recorder.record("model", row.model)
      }
    }
  } finally {
    database.close()
  }
}

function visitActive(value: unknown, recorder: ForbiddenTargetRecorder, key = "") {
  if (typeof value === "string") {
    if (
      /provider|model|plugin|mcp|skill|share|update|command|exec|binary|runtime|server|url|host|origin|endpoint/i.test(
        key,
      )
    ) {
      recorder.record(key, value)
    }
    return
  }
  if (Array.isArray(value)) return value.forEach((item) => visitActive(item, recorder, key))
  if (!value || typeof value !== "object") return
  for (const [child, item] of Object.entries(value)) visitActive(item, recorder, child)
}

async function databaseFixture() {
  const fixture = await emptyFixture("database")
  const data = path.join(fixture.home, ".local", "share", "opencode")
  const config = path.join(fixture.home, ".config", "opencode")
  await Promise.all([mkdir(data, { recursive: true, mode: 0o700 }), mkdir(config, { recursive: true, mode: 0o700 })])
  await writeFile(
    path.join(config, "opencode.json"),
    JSON.stringify({ theme: "dark", provider: "opencode", server: { url: "https://opencode.ai" } }),
    { mode: 0o600 },
  )
  const database = new BunDatabase(path.join(data, "opencode.db"), { create: true })
  database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
  database.run("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
  database.run("CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
  database.run("CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
  database.run("CREATE TABLE account(id TEXT PRIMARY KEY, token TEXT)")
  database.run("INSERT INTO session VALUES ('ses_1', 'retained', 'opencode/coder')")
  database.run(
    `INSERT INTO message VALUES ('msg_1', '{"role":"assistant","text":"Harmless transcript: opencode serve uses https://opencode.ai"}')`,
  )
  database.run(`INSERT INTO part VALUES ('prt_1', '{"type":"text","text":"retained answer"}')`)
  database.run(
    `INSERT INTO permission VALUES ('project_1', '{"command":"opencode serve","url":"https://opencode.ai"}')`,
  )
  database.run("INSERT INTO account VALUES ('account_1', 'secret')")
  database.close()
  fixture.input.candidates = releasedSchemaCandidatesFromMigrations([
    {
      version: "fixture-v1",
      sql: "CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT); CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL);",
    },
  ])
  return fixture
}

async function configFixture() {
  const fixture = await emptyFixture("config")
  const config = path.join(fixture.home, ".config", "opencode")
  await mkdir(config, { recursive: true, mode: 0o700 })
  await writeFile(path.join(config, "opencode.json"), '{"theme":"dark"}', { mode: 0o600 })
  return fixture
}

async function emptyFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `bharatcode-recovery-${name}-`))
  roots.push(root)
  const home = path.join(root, "home")
  const destination = target(root)
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(destination.data, { recursive: true, mode: 0o700 }),
    mkdir(destination.config, { recursive: true, mode: 0o700 }),
    mkdir(destination.state, { recursive: true, mode: 0o700 }),
    mkdir(destination.storage, { recursive: true, mode: 0o700 }),
  ])
  const input: RecoveryControllerInput = {
    platform: "linux",
    home,
    env: {},
    destination,
    candidates: releasedSchemaCandidatesFromMigrations([
      { version: "fixture-v1", sql: "CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT NOT NULL);" },
    ]),
    open: openSchema,
  }
  return { root, home, destination, input }
}

async function durableEdgeFixture(name: string) {
  const fixture = await emptyFixture(`edge-${name}`)
  const config = path.join(fixture.root, "legacy-config")
  const data = path.join(fixture.root, "legacy-data")
  const desktop = path.join(fixture.root, "legacy-desktop")
  await Promise.all([
    mkdir(config, { recursive: true }),
    mkdir(path.join(data, "storage", "session"), { recursive: true }),
    mkdir(desktop, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(config, "settings.json"), '{"theme":"dark"}'),
    writeFile(path.join(data, "storage", "session", "ses_1.json"), '{"id":"ses_1","title":"retained"}'),
    writeFile(path.join(desktop, "preferences.json"), '{"theme":"dark"}'),
  ])
  const database = new BunDatabase(path.join(data, "opencode.db"), { create: true })
  database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
  database.run("INSERT INTO session VALUES ('ses_1', 'retained', NULL)")
  database.close()
  fixture.input.candidates = releasedSchemaCandidatesFromMigrations([
    { version: "fixture-v1", sql: "CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT);" },
  ])
  return {
    ...fixture,
    source: {
      id: `durable-${name}`,
      label: `Existing BharatCode data · opencode-cli · ${name}`,
      kind: "opencode-cli",
      roots: { config, data, desktop },
    } satisfies MigrationSource,
  }
}

async function installThroughDatabaseSwitch(destination: MigrationDestination) {
  const journal = JSON.parse(await readFile(path.join(destination.state, "lean-migration-v1.json"), "utf8")) as {
    snapshotDigest: string
  }
  const snapshot = path.join(destination.state, "migration-snapshots", journal.snapshotDigest)
  const manifest = JSON.parse(await readFile(path.join(snapshot, "manifest.json"), "utf8")) as {
    entries: readonly { relative: string }[]
  }
  for (const entry of manifest.entries) {
    const edge = entry.relative.split("/")[0]
    if (!edge || !["config", "data", "database"].includes(edge)) continue
    const relative = entry.relative.slice(edge.length + 1)
    const targetFile =
      edge === "config"
        ? path.join(destination.config, relative)
        : edge === "data"
          ? path.join(destination.data, relative)
          : destination.database
    await mkdir(path.dirname(targetFile), { recursive: true })
    await writeFile(targetFile, await readFile(path.join(snapshot, "records", entry.relative)))
  }
}

function target(root: string): MigrationDestination {
  return {
    data: path.join(root, "destination", "data"),
    config: path.join(root, "destination", "config"),
    state: path.join(root, "destination", "state"),
    database: path.join(root, "destination", "data", "bharatcode.db"),
    storage: path.join(root, "destination", "data", "storage"),
  }
}

function createCompatibleDatabase(file: string) {
  const database = new BunDatabase(file, { create: true })
  database.run("CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT NOT NULL)")
  database.close()
}

function openSchema(file: string, options: { readonly: boolean }): SchemaDatabase {
  const database = new BunDatabase(file, options)
  return {
    rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
    close: () => database.close(),
  }
}

function childEnvironment(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_TEST_HOME: home,
    BHARATCODE_CHANNEL: "test",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  }
  for (const name of ["OPENCODE_DB", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    delete env[name]
  }
  return env
}

async function runCli(env: Record<string, string | undefined>, args: readonly string[]) {
  return parseRecoveryCommandResult(await runCliRaw(env, args))
}

async function runCliRaw(env: Record<string, string | undefined>, args: readonly string[]) {
  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", "./src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`closed CLI recovery failed (${exit}): ${stderr.split("\n")[0] ?? ""}`)
  return stdout
}
