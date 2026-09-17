import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  createRecoveryController,
  parseRecoveryCommandResult,
  startupRecoveryBlocker,
  type RecoveryCommandResult,
} from "@/cli/cmd/doctor"
import { releasedSchemaCandidatesFromMigrations, type SchemaDatabase } from "@/storage/schema-marker"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("bharatcode doctor and recovery adapter", () => {
  test("only destination integrity blocks startup; a missing database does not", () => {
    // Nothing usable yet: startup initializes a clean destination rather than refusing.
    expect(startupRecoveryBlocker({ state: "ready" })).toBeUndefined()
    expect(startupRecoveryBlocker({ state: "start-fresh", reason: "no-source" })).toBeUndefined()
    expect(startupRecoveryBlocker({ state: "start-fresh", reason: "ambiguous" })).toBeUndefined()
    expect(
      startupRecoveryBlocker({
        state: "choose-source",
        sources: [{ id: "source-1", label: "Existing BharatCode data", contentFingerprint: "a".repeat(64) }],
      }),
    ).toBeUndefined()

    // The destination itself is in doubt: refuse, and name the command that resolves it.
    expect(startupRecoveryBlocker({ state: "retry", operationID: "op-1" })).toContain("recovery retry --operation-id")
    expect(startupRecoveryBlocker({ state: "marker-repair", diagnosis: "invalid" })).toContain("doctor repair")
    expect(startupRecoveryBlocker({ state: "blocked", reason: "corrupt" })).toContain("doctor")
  })

  test("diagnosis is read-only and compatible marker repair requires explicit confirmation", async () => {
    const fixture = await setup()
    createFixtureDatabase(fixture.destination.database)
    const marker = path.join(fixture.destination.data, ".schema-version")
    await writeFile(marker, "broken", { mode: 0o600 })
    const before = await readFile(fixture.destination.database)
    const controller = createRecoveryController(fixture.input)

    expect(await controller.inspect()).toEqual({
      state: "marker-repair",
      diagnosis: "invalid",
      inferredVersion: "fixture-v1",
    })
    expect(await readFile(fixture.destination.database)).toEqual(before)
    expect(await readFile(marker, "utf8")).toBe("broken")

    await expect(controller.run({ type: "repair-marker", confirmed: false })).rejects.toThrow("explicit confirmation")
    expect(await controller.run({ type: "repair-marker", confirmed: true })).toEqual({ state: "ready" })
    expect(await readFile(marker, "utf8")).toBe("fixture-v1\n")
    expect(await readFile(fixture.destination.database)).toEqual(before)
  })

  test("requires an explicit stable source choice, rejects stale choices, preserves source, and converges on Retry", async () => {
    const fixture = await setup()
    const sourceConfig = path.join(fixture.home, ".config", "opencode")
    await mkdir(sourceConfig, { recursive: true, mode: 0o700 })
    const sourceFile = path.join(sourceConfig, "opencode.json")
    await writeFile(sourceFile, JSON.stringify({ theme: "dark" }), { mode: 0o600 })
    const controller = createRecoveryController(fixture.input)

    const first = await controller.inspect()
    expect(first.state).toBe("choose-source")
    if (first.state !== "choose-source") throw new Error("expected source choice")
    expect(first.sources).toHaveLength(1)
    expect(first.sources[0]?.label).not.toContain(sourceConfig)

    await writeFile(sourceFile, JSON.stringify({ theme: "light" }), { mode: 0o600 })
    const stale = await controller.run({
      type: "choose-source",
      id: first.sources[0]!.id,
      contentFingerprint: first.sources[0]!.contentFingerprint,
    })
    expect(stale.state).toBe("choose-source")
    expect(await readFile(sourceFile, "utf8")).toContain("light")

    const current = await controller.inspect()
    if (current.state !== "choose-source") throw new Error("expected refreshed source choice")
    const selected = current.sources[0]!
    const complete = await controller.run({
      type: "choose-source",
      id: selected.id,
      contentFingerprint: selected.contentFingerprint,
    })
    const completedJournal = JSON.parse(
      await readFile(path.join(fixture.destination.state, "lean-migration-v1.json"), "utf8"),
    )
    expect(completedJournal.destinationFingerprint).toBe(
      createHash("sha256")
        .update(
          [
            fixture.destination.data,
            fixture.destination.config,
            fixture.destination.state,
            fixture.destination.database,
            fixture.destination.storage,
          ]
            .map((item) => path.resolve(item))
            .join("\0"),
        )
        .digest("hex"),
    )
    expect(complete).toEqual({ state: "ready" })
    expect(await readFile(sourceFile, "utf8")).toContain("light")

    const journal = JSON.parse(await readFile(path.join(fixture.destination.state, "lean-migration-v1.json"), "utf8"))
    expect(await controller.run({ type: "retry", operationID: journal.operationID })).toEqual({ state: "ready" })
    expect(await controller.inspect()).toEqual({ state: "ready" })
  })

  test("excludes an incompatible source without hiding a valid recovery choice", async () => {
    const fixture = await setup()
    const validSource = path.join(fixture.home, ".bharatcode")
    await mkdir(validSource, { recursive: true, mode: 0o700 })
    await writeFile(path.join(validSource, "settings.json"), "{}", { mode: 0o600 })

    const invalidData = path.join(fixture.home, ".local", "share", "opencode")
    await mkdir(invalidData, { recursive: true, mode: 0o700 })
    const invalidDatabase = new Database(path.join(invalidData, "opencode.db"), { create: true })
    invalidDatabase.run("CREATE TABLE runtime_capability(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    invalidDatabase.close()

    const result = await createRecoveryController({ ...fixture.input, platform: "win32" }).inspect()
    expect(result.state).toBe("choose-source")
    if (result.state !== "choose-source") throw new Error("expected source choice")
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.id.startsWith("bharatcode-desktop-")).toBe(true)
  })

  test("Start Fresh is marker-independent, confirmation-bound, and idempotent", async () => {
    const fixture = await setup()
    const controller = createRecoveryController(fixture.input)
    expect(await controller.inspect()).toEqual({ state: "start-fresh", reason: "no-source" })
    await expect(controller.run({ type: "start-fresh", confirmed: false })).rejects.toThrow("explicit confirmation")
    expect(await controller.run({ type: "start-fresh", confirmed: true })).toEqual({ state: "ready" })
    expect(await controller.inspect()).toEqual({ state: "ready" })
  })

  test("accepts only the closed command result schema", () => {
    const result: RecoveryCommandResult = {
      state: "choose-source",
      sources: [{ id: "source-1", label: "Existing BharatCode data", contentFingerprint: "a".repeat(64) }],
    }
    expect(parseRecoveryCommandResult(`${JSON.stringify(result)}\n`)).toEqual(result)
    expect(() => parseRecoveryCommandResult(JSON.stringify({ ...result, sourcePath: "/secret" }))).toThrow(
      "invalid recovery result",
    )
    expect(() => parseRecoveryCommandResult(JSON.stringify({ state: "ready", credential: "secret" }))).toThrow(
      "invalid recovery result",
    )
  })

  test("registers the real CLI command and starts cleanly when there is nothing to migrate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bharatcode-doctor-cli-"))
    roots.push(root)
    const env: Record<string, string | undefined> = {
      ...process.env,
      OPENCODE_TEST_HOME: root,
      BHARATCODE_CHANNEL: "test",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    }
    for (const name of ["OPENCODE_DB", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      delete env[name]
    }
    // The canonical destination is platform-specific; a fixed XDG path silently
    // makes every existence assertion vacuous on macOS.
    const destination =
      process.platform === "darwin"
        ? path.join(root, "Library", "Application Support", "bharatcode-test")
        : path.join(root, ".local", "share", "bharatcode-test")
    const database = path.join(destination, "bharatcode.db")
    const marker = path.join(destination, ".schema-version")
    const spawn = async (args: readonly string[]) => {
      const child = Bun.spawn([process.execPath, "run", "--conditions=browser", "./src/index.ts", ...args], {
        cwd: path.join(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { out, error, exit }
    }

    // Informational invocations bypass recovery entirely and never touch the database.
    for (const args of [["--help"], ["--version"], ["db", "--help"]] as const) {
      const result = await spawn(args)
      expect(result.exit).toBe(0)
      expect(result.error).not.toContain("recovery is required")
      expect(await Bun.file(database).exists()).toBe(false)
      expect(await Bun.file(marker).exists()).toBe(false)
    }

    // Diagnosis stays read-only: it reports the pre-startup state without creating anything.
    const doctor = await spawn(["doctor"])
    expect(doctor.exit).toBe(0)
    expect(doctor.error).not.toContain("Performing one time database migration")
    expect(parseRecoveryCommandResult(doctor.out)).toEqual({ state: "start-fresh", reason: "no-source" })
    expect(await Bun.file(marker).exists()).toBe(false)

    // An ordinary command initializes a clean destination instead of refusing to start.
    const started = await spawn(["db", "path"])
    expect(started.exit).toBe(0)
    expect(started.error).not.toContain("recovery is required")
    expect(await Bun.file(marker).exists()).toBe(true)

    // The destination is ready from then on.
    const after = await spawn(["doctor"])
    expect(parseRecoveryCommandResult(after.out)).toEqual({ state: "ready" })
  }, 40_000)
})

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "bharatcode-doctor-"))
  roots.push(root)
  const home = path.join(root, "home")
  const destination = {
    data: path.join(root, "destination", "data"),
    config: path.join(root, "destination", "config"),
    state: path.join(root, "destination", "state"),
    database: path.join(root, "destination", "data", "bharatcode.db"),
    storage: path.join(root, "destination", "data", "storage"),
  }
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(destination.data, { recursive: true, mode: 0o700 }),
    mkdir(destination.config, { recursive: true, mode: 0o700 }),
    mkdir(destination.state, { recursive: true, mode: 0o700 }),
    mkdir(destination.storage, { recursive: true, mode: 0o700 }),
  ])
  const candidates = releasedSchemaCandidatesFromMigrations([
    { version: "fixture-v1", sql: "CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT NOT NULL);" },
  ])
  return {
    home,
    destination,
    input: {
      platform: "linux" as const,
      home,
      env: {},
      destination,
      candidates,
      open: openSchema,
    },
  }
}

function createFixtureDatabase(file: string) {
  const database = new Database(file, { create: true })
  database.run("CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT NOT NULL)")
  database.close()
}

function openSchema(file: string, options: { readonly: boolean }): SchemaDatabase {
  const database = new Database(file, options)
  return {
    rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
    close: () => database.close(),
  }
}
