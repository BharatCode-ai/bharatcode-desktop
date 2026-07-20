import { Database as BunDatabase } from "bun:sqlite"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
type RuntimeReceipt = {
  attempts: readonly { kind: "fetch" | "connect" | "spawn" | "schema" | "provider" | "authorize"; target: string }[]
  forbiddenAttempts: readonly unknown[]
  shareAttempts: readonly unknown[]
  checks: { boundaryClosed: boolean }
}
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
  test("explicitly chooses, sanitizes, preserves, repairs, and restarts", async () => {
    const fixture = await databaseFixture()
    const sourceDatabase = path.join(fixture.home, ".local", "share", "opencode", "opencode.db")
    const sourceConfig = path.join(fixture.home, ".config", "opencode", "opencode.json")
    const sourceLog = path.join(fixture.home, ".local", "share", "opencode", "log", "beta.log")
    const sourceRecord = path.join(fixture.home, ".local", "share", "opencode", "legacy-record.txt")
    const sourceDatabaseBytes = await readFile(sourceDatabase)
    const sourceConfigBytes = await readFile(sourceConfig)
    const sourceLogBytes = await readFile(sourceLog)
    const sourceRecordBytes = await readFile(sourceRecord)
    expect(sourceConfigBytes.toString()).toContain("https://opencode.ai")

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
    expect(await readFile(sourceLog)).toEqual(sourceLogBytes)
    expect(await readFile(sourceRecord)).toEqual(sourceRecordBytes)
    expect(await readFile(path.join(fixture.destination.data, "log", "beta.log"))).toEqual(sourceLogBytes)
    expect(await readFile(path.join(fixture.destination.data, "legacy-record.txt"))).toEqual(sourceRecordBytes)
    expect(JSON.parse(await readFile(path.join(fixture.destination.config, "bharatcode.json"), "utf8"))).toEqual({
      theme: "dark",
      snapshot: false,
    })
    expect(await Bun.file(path.join(fixture.destination.config, "opencode.json")).exists()).toBe(false)
    const activated = new BunDatabase(fixture.destination.database, { readonly: true })
    expect(activated.query("SELECT title, model FROM session").get()).toEqual({ title: "retained", model: null })
    expect(activated.query("SELECT data FROM message").get()).toEqual({
      data: '{"role":"assistant","text":"Harmless transcript: opencode serve uses https://opencode.ai"}',
    })
    expect(activated.query("SELECT count(*) AS count FROM permission").get()).toEqual({ count: 0 })
    activated.close()

    expect(await createRecoveryController(fixture.input).inspect()).toEqual({ state: "ready" })
    receipts.push({ scenario: 6, proof: "explicit-sanitized-preserved-restart", assertions: 13 })
  }, 20_000)

  test("real CLI metadata and recovery commands cannot poison a later legacy log cutover", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bharatcode-recovery-bootstrap-"))
    roots.push(root)
    const home = path.join(root, "home")
    const sourceData = path.join(home, ".local", "share", "opencode")
    const sourceConfig = path.join(home, ".config", "opencode")
    const sourceLog = path.join(sourceData, "log", "beta.log")
    const sourceRecord = path.join(sourceData, "legacy-record.txt")
    const sourceConfiguration = path.join(sourceConfig, "opencode.json")
    await Promise.all([
      mkdir(path.dirname(sourceLog), { recursive: true, mode: 0o700 }),
      mkdir(sourceConfig, { recursive: true, mode: 0o700 }),
    ])
    await Promise.all([
      writeFile(sourceLog, "legacy beta log\n", { mode: 0o600 }),
      writeFile(sourceRecord, "retained legacy data\n", { mode: 0o600 }),
      writeFile(sourceConfiguration, '{"theme":"dark","snapshot":false}', { mode: 0o600 }),
    ])
    const sourceBytes = await Promise.all([sourceLog, sourceRecord, sourceConfiguration].map((file) => readFile(file)))
    const env = childEnvironment(home)
    const destinationData = path.join(home, ".local", "share", "bharatcode-test")
    const destinationConfig = path.join(home, ".config", "bharatcode-test")
    const destinationState = path.join(home, ".local", "state", "bharatcode-test")
    const ordinaryArtifacts = [
      destinationData,
      destinationConfig,
      path.join(destinationState, "log"),
      path.join(home, ".cache", "bharatcode-test", "bin"),
    ]

    const blocked = await runCliProcess(env, ["db", "path"])
    expect(blocked.exit).toBe(1)
    expect(blocked.stderr).toContain("BharatCode recovery is required")
    expect(await Promise.all(ordinaryArtifacts.map(entryExists))).toEqual([false, false, false, false])

    for (const invocation of [
      ["--model", "doctor"],
      ["-m", "recovery"],
      ["--", "doctor"],
      ["run", "--model=--help", "safe"],
      ["run", "--", "--version"],
    ]) {
      const result = await runCliProcess(env, invocation)
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain("BharatCode recovery is required")
      expect(await Promise.all(ordinaryArtifacts.map(entryExists))).toEqual([false, false, false, false])
    }

    for (const invocation of [["--help"], ["-h"], ["--version"], ["-v"], ["db", "--help"], ["db", "-h"]]) {
      await runCliRaw(env, invocation)
    }
    expect(await Promise.all(ordinaryArtifacts.map(entryExists))).toEqual([false, false, false, false])

    const first = parseRecoveryCommandResult(await runCliRaw(env, ["recovery", "status", "--json"]))
    const repeated = parseRecoveryCommandResult(await runCliRaw(env, ["recovery", "status", "--json"]))
    expect(parseRecoveryCommandResult(await runCliRaw(env, ["doctor"]))).toEqual(first)
    expect(repeated).toEqual(first)
    if (first.state !== "choose-source") throw new Error("expected explicit source choice")
    expect(await Promise.all(ordinaryArtifacts.map(entryExists))).toEqual([false, false, false, false])

    const selected = first.sources[0]!
    expect(
      await runCli(env, [
        "recovery",
        "choose-source",
        "--id",
        selected.id,
        "--content-fingerprint",
        selected.contentFingerprint,
        "--json",
      ]),
    ).toEqual({ state: "ready" })
    expect(await Promise.all([sourceLog, sourceRecord, sourceConfiguration].map((file) => readFile(file)))).toEqual(
      sourceBytes,
    )
    expect(await readFile(path.join(destinationData, "log", "beta.log"))).toEqual(sourceBytes[0]!)
    expect(await readFile(path.join(destinationData, "legacy-record.txt"))).toEqual(sourceBytes[1]!)
    expect(await readFile(path.join(destinationConfig, "bharatcode.json"))).toEqual(sourceBytes[2]!)
    expect(await entryExists(path.join(destinationState, "log"))).toBe(false)
    expect(await entryExists(path.join(destinationData, "repos"))).toBe(false)
    expect(parseRecoveryCommandResult(await runCliRaw(env, ["recovery", "status", "--json"]))).toEqual({
      state: "ready",
    })
    const journal = JSON.parse(await readFile(path.join(destinationState, "lean-migration-v1.json"), "utf8")) as {
      operationID: string
    }
    expect(await runCli(env, ["recovery", "retry", "--operation-id", journal.operationID, "--json"])).toEqual({
      state: "ready",
    })
    expect(await entryExists(path.join(destinationState, "log"))).toBe(false)

    expect((await runCliRaw(env, ["--pure", "db", "path"])).trim()).toBe(path.join(destinationData, "bharatcode.db"))
    expect(await entryExists(path.join(destinationState, "log"))).toBe(true)
    expect(await entryExists(path.join(destinationData, "repos"))).toBe(true)
    expect(await Promise.all([sourceLog, sourceRecord, sourceConfiguration].map((file) => readFile(file)))).toEqual(
      sourceBytes,
    )
  }, 60_000)

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

  test("fails closed when legacy and canonical global configuration names collide", async () => {
    const fixture = await configFixture()
    const sourceConfig = path.join(fixture.home, ".config", "opencode")
    await writeFile(path.join(sourceConfig, "bharatcode.json"), '{"snapshot":true}', { mode: 0o600 })

    await expect(createRecoveryController(fixture.input).inspect()).rejects.toThrow("canonical destination collision")
    expect(await Bun.file(path.join(fixture.destination.config, "bharatcode.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(sourceConfig, "opencode.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(sourceConfig, "bharatcode.json")).exists()).toBe(true)
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

  test("real CLI and Desktop converge and execute the migrated config through instrumented runtime boundaries", async () => {
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
    const sourceConfig = path.join(fixture.home, ".config", "opencode", "opencode.json")
    const canonicalConfig = path.join(fixture.home, ".config", "bharatcode-test", "bharatcode.json")
    expect(await Bun.file(sourceConfig).exists()).toBe(true)
    expect(await Bun.file(canonicalConfig).exists()).toBe(true)
    expect(await Bun.file(path.join(fixture.home, ".config", "bharatcode-test", "opencode.json")).exists()).toBe(false)

    const commandProject = path.join(fixture.root, "debug-config-project")
    await mkdir(commandProject, { recursive: true })
    const resolved = JSON.parse(await runCliRaw(env, ["--pure", "debug", "config"], commandProject)) as {
      snapshot?: boolean
      provider?: unknown
      server?: unknown
    }
    expect(resolved.snapshot).toBe(false)
    expect(resolved.provider).toBeUndefined()
    expect(resolved.server).toBeUndefined()

    const runtime = await runVerticalRuntime(env, path.join(fixture.root, "vertical-project"))
    expect(runtime.forbiddenAttempts).toEqual([])
    expect(runtime.shareAttempts).toEqual([])
    expect(runtime.checks.boundaryClosed).toBe(true)
    expect(new Set(runtime.attempts.map((attempt) => attempt.kind))).toEqual(
      new Set(["fetch", "connect", "spawn", "schema", "provider", "authorize"]),
    )
    receipts.push({ scenario: 7, proof: "real-cli-desktop-runtime-boundary-convergence", assertions: 15 })
  }, 120_000)
})

async function databaseFixture() {
  const fixture = await emptyFixture("database")
  await rm(fixture.destination.storage, { recursive: true })
  const data = path.join(fixture.home, ".local", "share", "opencode")
  const config = path.join(fixture.home, ".config", "opencode")
  await Promise.all([
    mkdir(path.join(data, "log"), { recursive: true, mode: 0o700 }),
    mkdir(config, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    writeFile(path.join(data, "log", "beta.log"), "legacy beta log\n", { mode: 0o600 }),
    writeFile(path.join(data, "legacy-record.txt"), "retained legacy data\n", { mode: 0o600 }),
  ])
  await writeFile(
    path.join(config, "opencode.json"),
    JSON.stringify({ theme: "dark", snapshot: false, provider: "opencode", server: { url: "https://opencode.ai" } }),
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
  database.run("INSERT INTO account VALUES ('account_1', 'legacy-secret-token')")
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
  await writeFile(path.join(config, "opencode.json"), '{"theme":"dark","snapshot":false}', { mode: 0o600 })
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

async function entryExists(entry: string) {
  return lstat(entry).then(
    () => true,
    (error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}

async function runCli(env: Record<string, string | undefined>, args: readonly string[]) {
  return parseRecoveryCommandResult(await runCliRaw(env, args))
}

async function runCliRaw(env: Record<string, string | undefined>, args: readonly string[], cwd?: string) {
  const result = await runCliProcess(env, args, cwd)
  if (result.exit !== 0) {
    throw new Error(`closed CLI recovery failed (${result.exit}): ${result.stderr.slice(-2000)}`)
  }
  return result.stdout
}

async function runCliProcess(env: Record<string, string | undefined>, args: readonly string[], cwd?: string) {
  const packageRoot = path.join(import.meta.dir, "../..")
  const child = Bun.spawn(
    [process.execPath, "run", "--conditions=browser", path.join(packageRoot, "src", "index.ts"), "--", ...args],
    {
      cwd: cwd ?? packageRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exit }
}

async function runVerticalRuntime(env: Record<string, string | undefined>, project: string): Promise<RuntimeReceipt> {
  const packageRoot = path.join(import.meta.dir, "../..")
  const child = Bun.spawn([process.execPath, "test/product/fixtures/core-vertical-worker.ts"], {
    cwd: packageRoot,
    env: { ...env, BHARATCODE_ACCEPTANCE_PROJECT: project },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`instrumented runtime failed (${exit}): ${stderr.slice(-2000)}`)
  return JSON.parse(stdout) as RuntimeReceipt
}
