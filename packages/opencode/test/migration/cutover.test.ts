import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

import { fingerprintMigrationSource, type MigrationDestination } from "@/migration/capture"
import { activateMigration, prepareMigration, startFresh, validateFreshDestination } from "@/migration/cutover"
import type { MigrationSource } from "@/migration/source"
import { tmpdir } from "../fixture/fixture"

type SwitchEdge = "config" | "data" | "database" | "desktop"

describe("migration cutover", () => {
  const switchEdges: SwitchEdge[] = ["config", "data", "database", "desktop"]

  test("returns closed actions for zero and ambiguous sources", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    expect(await prepareMigration({ sources: [], destination })).toEqual({
      type: "start-fresh",
      reason: "no-source",
    })
    const first = await source(tmp.path, "first")
    const second = await source(tmp.path, "second")
    const result = await prepareMigration({ sources: [second, first], destination })
    expect(result.type).toBe("choose-source")
    if (result.type !== "choose-source") throw new Error("expected source choice")
    expect(result.sources.map((item) => item.id)).toEqual([first.id, second.id])
    expect(result.sources.every((item) => /^[0-9a-f]{64}$/.test(item.contentFingerprint))).toBe(true)
  })

  test("uses the disjoint macOS recovery root and quarantines prior nested app state once", async () => {
    await using tmp = await tmpdir()
    const paths = StoragePaths.resolve({
      channel: "beta",
      platform: "darwin",
      home: tmp.path,
      temp: path.join(tmp.path, "tmp"),
      env: {},
    })
    const destination: MigrationDestination = {
      data: paths.data,
      config: paths.config,
      state: paths.recovery,
      database: paths.database,
      storage: paths.storage,
    }
    await mkdir(paths.state, { recursive: true })
    await writeFile(path.join(paths.state, "session.json"), '{"remembered":"ses_safe"}')

    const result = await startFresh({ destination, reason: "no-source", confirmed: true })

    expect(result.state).toBe("fresh")
    expect(result.quarantine).toBeDefined()
    expect(await Bun.file(path.join(result.quarantine!, "data", "State", "session.json")).text()).toBe(
      '{"remembered":"ses_safe"}',
    )
    expect(await Bun.file(path.join(paths.recovery, "lean-migration-v1.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(paths.state, "session.json")).exists()).toBe(false)
    expect(await validateFreshDestination(destination)).toBe(true)
  })

  test("prepares and activates a selected source with the canonical macOS layout", async () => {
    await using tmp = await tmpdir()
    const paths = StoragePaths.resolve({
      channel: "beta",
      platform: "darwin",
      home: tmp.path,
      temp: path.join(tmp.path, "tmp"),
      env: {},
    })
    const destination: MigrationDestination = {
      data: paths.data,
      config: paths.config,
      state: paths.recovery,
      database: paths.database,
      storage: paths.storage,
    }
    const candidate = await source(tmp.path, "mac-existing")
    const contentFingerprint = await fingerprintMigrationSource(candidate)

    const prepared = await prepareMigration({
      sources: [candidate],
      choice: { id: candidate.id, contentFingerprint },
      destination,
    })
    if (prepared.type !== "prepared") throw new Error("expected prepared macOS migration")
    expect(await activateMigration({ operationID: prepared.operationID, destination })).toEqual({
      state: "complete",
      sourceID: candidate.id,
    })
    expect(await Bun.file(path.join(paths.config, "settings.json")).text()).not.toContain("opencode.ai")
    expect(await Bun.file(path.join(paths.recovery, "lean-migration-v1.json")).exists()).toBe(true)
    expect(await validateFreshDestination(destination)).toBe(true)
  })

  test("rejects a stale choice and never mixes newly changed source bytes", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const fingerprint = await fingerprintMigrationSource(candidate)
    await writeFile(path.join(candidate.roots.config!, "settings.json"), JSON.stringify({ theme: "changed" }))
    const result = await prepareMigration({
      sources: [candidate],
      choice: { id: candidate.id, contentFingerprint: fingerprint },
      destination: target(tmp.path),
    })
    expect(result.type).toBe("choose-source")
  })

  test("prepares, activates, validates, completes, and retries idempotently from the sealed snapshot", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const destination = target(tmp.path)
    const prepared = await prepareMigration({ sources: [candidate], destination })
    expect(prepared.type).toBe("prepared")
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")
    const sourceBytes = await readFile(path.join(candidate.roots.config!, "settings.json"))

    const complete = await activateMigration({ operationID: prepared.operationID, destination })
    expect(complete).toEqual({ state: "complete", sourceID: candidate.id })
    expect(await activateMigration({ operationID: prepared.operationID, destination })).toEqual(complete)
    expect(await validateFreshDestination(destination)).toBe(true)
    expect(await readFile(path.join(candidate.roots.config!, "settings.json"))).toEqual(sourceBytes)
    expect(await Bun.file(path.join(destination.config, "settings.json")).text()).not.toContain("opencode.ai")
  })

  test("serializes simultaneous callers on one destination operation", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const destination = target(tmp.path)
    const results = await Promise.all([
      prepareMigration({ sources: [candidate], destination }),
      prepareMigration({ sources: [candidate], destination }),
    ])
    expect(results.filter((item) => item.type === "prepared")).toHaveLength(1)
    expect(results.filter((item) => item.type === "retry")).toHaveLength(1)
  })

  test("Retry converges after a crash between per-root activation switches", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const destination = target(tmp.path)
    const prepared = await prepareMigration({ sources: [candidate], destination })
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")
    const journal = JSON.parse(await Bun.file(path.join(destination.state, "lean-migration-v1.json")).text()) as {
      snapshotDigest: string
    }
    await mkdir(destination.config, { recursive: true })
    await Bun.write(
      path.join(destination.config, "settings.json"),
      await Bun.file(
        path.join(
          destination.state,
          "migration-snapshots",
          journal.snapshotDigest,
          "records",
          "config",
          "settings.json",
        ),
      ).arrayBuffer(),
    )

    expect(await activateMigration({ operationID: prepared.operationID, destination })).toEqual({
      state: "complete",
      sourceID: candidate.id,
    })
  })

  test.each(switchEdges)("Retry converges after the %s durable switch edge", async (edge) => {
    await using tmp = await tmpdir()
    const fixture = await durableSwitchFixture(tmp.path)
    const before = await Promise.all(fixture.sourceFiles.map((file) => readFile(file)))
    const prepared = await prepareMigration({ sources: [fixture.source], destination: fixture.destination })
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")
    await installDurableSwitches(fixture.destination, edge)

    expect(await activateMigration({ operationID: prepared.operationID, destination: fixture.destination })).toEqual({
      state: "complete",
      sourceID: fixture.source.id,
    })
    expect(await validateFreshDestination(fixture.destination)).toBe(true)
    expect(await Promise.all(fixture.sourceFiles.map((file) => readFile(file)))).toEqual(before)
    expect(await Bun.file(path.join(fixture.destination.config, "settings.json")).text()).toBe('{"theme":"dark"}')
    expect(await Bun.file(path.join(fixture.destination.storage, "session", "ses_1.json")).text()).toContain("retained")
    expect(await Bun.file(path.join(fixture.destination.data, "desktop", "preferences.json")).text()).toBe(
      '{"theme":"dark"}',
    )
    const activated = new Database(fixture.destination.database, { readonly: true })
    expect(activated.query("SELECT title FROM session").get()).toEqual({ title: "retained" })
    activated.close()
    expect(
      JSON.parse(await Bun.file(path.join(fixture.destination.state, "lean-migration-v1.json")).text()),
    ).toMatchObject({ phase: "complete", operationID: prepared.operationID })
  })

  test.each(switchEdges)("Retry rejects mutation of the already-switched %s unit", async (edge) => {
    await using tmp = await tmpdir()
    const fixture = await durableSwitchFixture(tmp.path)
    const prepared = await prepareMigration({ sources: [fixture.source], destination: fixture.destination })
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")
    await installDurableSwitches(fixture.destination, edge)
    await mutateDurableSwitch(fixture.destination, edge)

    await expect(
      activateMigration({ operationID: prepared.operationID, destination: fixture.destination }),
    ).rejects.toThrow("The migration destination changed.")
  })

  test("activates one sanitized canonical database from live WAL alongside retained data", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(path.join(data, "storage", "session"), { recursive: true })
    await writeFile(
      path.join(data, "storage", "session", "ses_1.json"),
      JSON.stringify({ id: "ses_1", title: "retained", model: "opencode/coder" }),
    )
    const legacyDatabase = path.join(data, "opencode.db")
    const writer = new Database(legacyDatabase, { create: true })
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    writer.run("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("CREATE TABLE account(id TEXT PRIMARY KEY, token TEXT)")
    writer.run("INSERT INTO session VALUES ('ses_1', 'kept', 'opencode/coder')")
    writer.run(
      'INSERT INTO message VALUES (\'msg_1\', \'{"role":"assistant","text":"Harmless discussion: opencode serve uses https://opencode.ai"}\')',
    )
    writer.run(
      'INSERT INTO part VALUES (\'prt_1\', \'{"type":"text","text":"Transcript mentions opencode serve and https://opencode.ai"}\')',
    )
    writer.run(
      'INSERT INTO permission VALUES (\'project_1\', \'{"command":"opencode serve","url":"https://opencode.ai"}\')',
    )
    writer.run("INSERT INTO account VALUES ('acct_1', 'legacy-secret-token')")
    const candidate: MigrationSource = {
      id: "wal-source",
      label: "Existing BharatCode data · opencode-cli · 00000000",
      kind: "opencode-cli",
      roots: { data },
    }
    const destination = target(tmp.path)
    const prepared = await prepareMigration({ sources: [candidate], destination })
    writer.close()
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")

    expect(await activateMigration({ operationID: prepared.operationID, destination })).toEqual({
      state: "complete",
      sourceID: candidate.id,
    })
    expect(await Bun.file(path.join(destination.storage, "session", "ses_1.json")).text()).toContain("retained")
    expect(await Bun.file(path.join(destination.data, "opencode.db")).exists()).toBe(false)
    const activated = new Database(destination.database, { readonly: true })
    expect(activated.query("SELECT title, model FROM session").get()).toEqual({ title: "kept", model: null })
    expect(activated.query("SELECT data FROM message").get()).toEqual({
      data: '{"role":"assistant","text":"Harmless discussion: opencode serve uses https://opencode.ai"}',
    })
    expect(activated.query("SELECT data FROM part").get()).toEqual({
      data: '{"type":"text","text":"Transcript mentions opencode serve and https://opencode.ai"}',
    })
    expect(activated.query("SELECT count(*) AS count FROM permission").get()).toEqual({ count: 0 })
    expect(() => activated.query("SELECT * FROM account").all()).toThrow()
    activated.close()
    const preserved = new Database(legacyDatabase, { readonly: true })
    expect(preserved.query("SELECT token FROM account").get()).toEqual({ token: "legacy-secret-token" })
    preserved.close()
  })

  test("Start Fresh is marker-independent, quarantines known partials, and preserves every source", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    const candidate = await source(tmp.path, "legacy")
    await mkdir(destination.storage, { recursive: true })
    await writeFile(destination.database, "partial-db")
    await writeFile(path.join(destination.storage, "partial.json"), "partial")
    await mkdir(destination.config, { recursive: true })
    await writeFile(path.join(destination.config, "partial.json"), "partial")
    const sourceBytes = await readFile(path.join(candidate.roots.config!, "settings.json"))

    const result = await startFresh({ destination, reason: "interrupted", confirmed: true })
    expect(result.state).toBe("fresh")
    expect(result.quarantine).toBeString()
    expect(await validateFreshDestination(destination)).toBe(true)
    expect(await readFile(path.join(candidate.roots.config!, "settings.json"))).toEqual(sourceBytes)
    await expect(startFresh({ destination, reason: "interrupted", confirmed: true })).rejects.toThrow("healthy")
  })

  test("fails closed for linked, conflicting, and healthy completed destinations", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    const outside = path.join(tmp.path, "outside")
    await mkdir(outside)
    await mkdir(path.dirname(destination.config), { recursive: true })
    await symlink(outside, destination.config)
    await expect(startFresh({ destination, reason: "interrupted", confirmed: true })).rejects.toThrow("link")

    const conflict = target(path.join(tmp.path, "conflict"))
    conflict.config = conflict.data
    await expect(startFresh({ destination: conflict, reason: "interrupted", confirmed: true })).rejects.toThrow(
      "overlap",
    )
  })

  test("Start Fresh refuses a healthy database without a journal and quarantines every active partial artifact", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    await mkdir(destination.data, { recursive: true })
    const healthy = new Database(destination.database, { create: true })
    healthy.run("CREATE TABLE session(id TEXT PRIMARY KEY)")
    healthy.close()
    await expect(startFresh({ destination, reason: "interrupted", confirmed: true })).rejects.toThrow("healthy")

    await Bun.file(destination.database).write("partial")
    await writeFile(path.join(destination.data, ".schema-version"), "legacy\n")
    await writeFile(path.join(destination.data, "auth.json"), '{"provider":"opencode"}')
    const result = await startFresh({ destination, reason: "invalid-marker", confirmed: true })
    expect(result.state).toBe("fresh")
    expect(await Bun.file(path.join(destination.data, ".schema-version")).exists()).toBe(false)
    expect(await Bun.file(path.join(destination.data, "auth.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(result.quarantine!, "manifest.json")).text()).toContain("sha256")
  })
})

async function source(root: string, id: string): Promise<MigrationSource> {
  const config = path.join(root, `source-${id}`)
  await mkdir(config, { recursive: true })
  await writeFile(
    path.join(config, "settings.json"),
    JSON.stringify({ theme: "dark", $schema: "https://opencode.ai/config.json" }),
  )
  return {
    id,
    label: `Existing BharatCode data · opencode-cli · ${id.padEnd(8, "0").slice(0, 8)}`,
    kind: "opencode-cli",
    roots: { config },
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

async function durableSwitchFixture(root: string) {
  const config = path.join(root, "legacy-config")
  const data = path.join(root, "legacy-data")
  const desktop = path.join(root, "legacy-desktop")
  const session = path.join(data, "storage", "session", "ses_1.json")
  const preferences = path.join(desktop, "preferences.json")
  await Promise.all([
    mkdir(config, { recursive: true }),
    mkdir(path.dirname(session), { recursive: true }),
    mkdir(desktop, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(config, "settings.json"), '{"theme":"dark"}'),
    writeFile(session, '{"id":"ses_1","title":"retained"}'),
    writeFile(preferences, '{"theme":"dark"}'),
  ])
  const database = path.join(data, "opencode.db")
  const sourceDatabase = new Database(database, { create: true })
  sourceDatabase.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
  sourceDatabase.run("INSERT INTO session VALUES ('ses_1', 'retained', NULL)")
  sourceDatabase.close()
  return {
    source: {
      id: "durable-switch-source",
      label: "Existing BharatCode data · opencode-cli · 00000000",
      kind: "opencode-cli",
      roots: { config, data, desktop },
    } satisfies MigrationSource,
    destination: target(root),
    sourceFiles: [path.join(config, "settings.json"), session, preferences, database],
  }
}

async function installDurableSwitches(destination: MigrationDestination, through: SwitchEdge) {
  const journal = JSON.parse(await Bun.file(path.join(destination.state, "lean-migration-v1.json")).text()) as {
    snapshotDigest: string
  }
  const snapshot = path.join(destination.state, "migration-snapshots", journal.snapshotDigest)
  const manifest = JSON.parse(await Bun.file(path.join(snapshot, "manifest.json")).text()) as {
    entries: readonly { relative: string }[]
  }
  const edges = ["config", "data", "database", "desktop"] as const
  for (const entry of manifest.entries) {
    const edge = edges.find((candidate) => entry.relative === candidate || entry.relative.startsWith(`${candidate}/`))
    if (!edge || edges.indexOf(edge) > edges.indexOf(through)) continue
    const relative = entry.relative.slice(edge.length + 1)
    const destinationRoot =
      edge === "config"
        ? destination.config
        : edge === "data"
          ? destination.data
          : edge === "database"
            ? path.dirname(destination.database)
            : path.join(destination.data, "desktop")
    const target = edge === "database" ? destination.database : path.join(destinationRoot, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, await readFile(path.join(snapshot, "records", entry.relative)))
  }
}

async function mutateDurableSwitch(destination: MigrationDestination, edge: SwitchEdge) {
  const target =
    edge === "config"
      ? path.join(destination.config, "settings.json")
      : edge === "data"
        ? path.join(destination.storage, "session", "ses_1.json")
        : edge === "database"
          ? destination.database
          : path.join(destination.data, "desktop", "preferences.json")
  await writeFile(target, "mutated")
}
