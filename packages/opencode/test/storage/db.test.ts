import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { it } from "../lib/effect"
import { Database as SQLite } from "bun:sqlite"
import { test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("schema inspection uses an actually read-only connection and cannot checkpoint or write application data", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "inspection.db")
  const seed = new SQLite(file, { create: true })
  seed.run("CREATE TABLE item(id INTEGER PRIMARY KEY)")
  seed.close()
  const before = await readFile(file)
  const inspection = Database.openSchemaDatabase(file, { readonly: true })
  try {
    expect(inspection.rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
    expect(() => inspection.rows("INSERT INTO item VALUES (1)")).toThrow()
  } finally {
    inspection.close()
  }
  expect(await readFile(file)).toEqual(before)
})

test("schema inspection rejects write-mode requests before opening or creating a database", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "must-not-exist.db")
  expect(() => Database.openSchemaDatabase(file, { readonly: false })).toThrow()
  expect(await Bun.file(file).exists()).toBe(false)
})

describe("Database.getChannelPath", () => {
  it.effect("returns the canonical BharatCode database path for every channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(Global.Path.database)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("does not fork the canonical database path for legacy channel flags", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(Global.Path.database)
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})
