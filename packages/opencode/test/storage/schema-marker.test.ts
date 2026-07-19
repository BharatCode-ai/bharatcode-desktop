import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  captureSchemaContract,
  diagnoseSchemaMarker,
  repairSchemaMarker,
  releasedSchemaCandidatesFromMigrations,
  type DiagnoseMarkerInput,
  type MarkerState,
  type SchemaDatabase,
} from "@/storage/schema-marker"
import { tmpdir } from "../fixture/fixture"

describe("schema marker diagnosis and repair", () => {
  test("derives exact released candidates and never trusts a marker as schema proof", async () => {
    await using tmp = await tmpdir()
    const databasePath = path.join(tmp.path, "bharatcode.db")
    createDatabase(databasePath)
    const input = diagnoseInput(databasePath)
    expect(diagnoseSchemaMarker(input)).toEqual({ state: "missing", inferredVersion: "v1" })
    await writeFile(path.join(tmp.path, ".schema-version"), "v1\n", { mode: 0o600 })
    expect(diagnoseSchemaMarker(input)).toEqual({ state: "healthy", inferredVersion: "v1" })
    await writeFile(path.join(tmp.path, ".schema-version"), "v2\n", { mode: 0o600 })
    expect(diagnoseSchemaMarker(input)).toEqual({ state: "schema-mismatch", inferredVersion: "v1" })
  })

  test.each<[string, MarkerState]>([
    ["empty", "invalid"],
    ["malformed value!", "invalid"],
    ["v1\n", "permission-invalid"],
  ])("classifies %s marker state without changing the database", async (contents, state) => {
    await using tmp = await tmpdir()
    const databasePath = path.join(tmp.path, "bharatcode.db")
    createDatabase(databasePath)
    const marker = path.join(tmp.path, ".schema-version")
    await writeFile(marker, contents, { mode: 0o600 })
    if (state === "permission-invalid") await chmod(marker, 0o644)
    const before = await readFile(databasePath)
    expect(diagnoseSchemaMarker(diagnoseInput(databasePath)).state).toBe(state)
    expect(await readFile(databasePath)).toEqual(before)
  })

  test("rejects linked, directory, corrupt, and unsupported-schema markers/databases", async () => {
    await using tmp = await tmpdir()
    const databasePath = path.join(tmp.path, "bharatcode.db")
    createDatabase(databasePath)
    const marker = path.join(tmp.path, ".schema-version")
    const outside = path.join(tmp.path, "outside")
    await writeFile(outside, "v1\n")
    await symlink(outside, marker)
    expect(diagnoseSchemaMarker(diagnoseInput(databasePath)).state).toBe("permission-invalid")

    await Bun.file(databasePath).write("not sqlite")
    expect(diagnoseSchemaMarker(diagnoseInput(databasePath)).state).toBe("corrupt")

    const unsupported = path.join(tmp.path, "unsupported.db")
    const db = new Database(unsupported, { create: true })
    db.run("CREATE TABLE other(id INTEGER PRIMARY KEY)")
    db.close()
    expect(diagnoseSchemaMarker(diagnoseInput(unsupported)).state).toBe("schema-mismatch")

    await using directoryMarker = await tmpdir()
    const directoryDatabase = path.join(directoryMarker.path, "bharatcode.db")
    createDatabase(directoryDatabase)
    await mkdir(path.join(directoryMarker.path, ".schema-version"))
    expect(diagnoseSchemaMarker(diagnoseInput(directoryDatabase)).state).toBe("invalid")
  })

  test("repairs only the marker after exact integrity/schema proof and is idempotent after durable edges", async () => {
    await using tmp = await tmpdir()
    const databasePath = path.join(tmp.path, "bharatcode.db")
    createDatabase(databasePath)
    const marker = path.join(tmp.path, ".schema-version")
    await writeFile(marker, "broken", { mode: 0o600 })
    const before = await readFile(databasePath)
    const repaired = repairSchemaMarker({ ...diagnoseInput(databasePath), confirmed: true })
    expect(repaired.state).toBe("repaired")
    expect(repaired.quarantine).toBeString()
    expect(await Bun.file(marker).text()).toBe("v1\n")
    expect(await readFile(databasePath)).toEqual(before)
    expect(repairSchemaMarker({ ...diagnoseInput(databasePath), confirmed: true }).state).toBe("unchanged")

    await writeFile(marker, "broken-again", { mode: 0o600 })
    const second = repairSchemaMarker({ ...diagnoseInput(databasePath), confirmed: true })
    expect(second.state).toBe("repaired")
    expect(diagnoseSchemaMarker(diagnoseInput(databasePath)).state).toBe("healthy")
  })

  test("never blesses corrupt or incompatible data", async () => {
    await using tmp = await tmpdir()
    const databasePath = path.join(tmp.path, "bharatcode.db")
    await writeFile(databasePath, "not sqlite")
    const result = repairSchemaMarker({ ...diagnoseInput(databasePath), confirmed: true })
    expect(result.state).toBe("failed")
    expect(await Bun.file(path.join(tmp.path, ".schema-version")).exists()).toBe(false)
  })
})

function createDatabase(databasePath: string) {
  const database = new Database(databasePath, { create: true })
  database.run("PRAGMA foreign_keys = ON")
  database.run("CREATE TABLE parent(id TEXT PRIMARY KEY)")
  database.run(
    "CREATE TABLE item(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id), value TEXT NOT NULL)",
  )
  database.run("CREATE INDEX item_parent_idx ON item(parent_id)")
  database.close()
}

function diagnoseInput(databasePath: string): DiagnoseMarkerInput {
  const migrations = releasedSchemaCandidatesFromMigrations([
    {
      version: "v1",
      sql: "CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE item(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id), value TEXT NOT NULL); CREATE INDEX item_parent_idx ON item(parent_id);",
    },
  ])
  return { databasePath, candidates: migrations, open }
}

function open(databasePath: string, options: { readonly: boolean }): SchemaDatabase {
  const database = new Database(databasePath, { readonly: options.readonly })
  return {
    rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
    close: () => database.close(),
  }
}

test("captureSchemaContract returns stable sorted schema", () => {
  const database = new Database(":memory:")
  database.run("CREATE TABLE z(id INTEGER PRIMARY KEY); CREATE TABLE a(id TEXT PRIMARY KEY)")
  const contract = captureSchemaContract({
    rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
    close: () => database.close(),
  })
  expect(contract.tables.map((table) => table.name)).toEqual(["a", "z"])
  database.close()
})
