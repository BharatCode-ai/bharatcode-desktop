import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { captureSupportDatabase } from "../../src/server/support-database"

test("captures only schema/migration metadata from an existing initialized database", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      yield* db.run(sql`DELETE FROM migration;`)
      yield* db.run(sql`INSERT INTO migration(id,time_completed) VALUES ('20261021000000_initial',1)`)
      yield* db.run(sql`CREATE TABLE private_fixture(content TEXT)`)
      yield* db.run(sql`INSERT INTO private_fixture VALUES ('sk-private owner@private.test https://private.test/repo')`)
      const result = yield* captureSupportDatabase().pipe(Effect.provideService(Database.Service, { db }))
      expect(result).toMatchObject({
        availability: "available",
        source: "runtime_snapshot",
        migrationFormat: "current",
        appliedCount: 1,
        latestMigration: 20261021000000,
      })
      expect(result.schemaVersion).toBeGreaterThan(0)
      expect(Date.parse(result.capturedAt)).not.toBeNaN()
      expect(Object.keys(result).sort()).toEqual(
        [
          "availability",
          "source",
          "schemaVersion",
          "migrationFormat",
          "appliedCount",
          "latestMigration",
          "capturedAt",
        ].sort(),
      )
      expect(JSON.stringify(result)).not.toContain("private")
      yield* db.run(sql`DROP TABLE migration`)
      const failed = yield* captureSupportDatabase().pipe(Effect.provideService(Database.Service, { db }))
      expect(failed).toMatchObject({
        availability: "unavailable",
        source: "runtime_snapshot",
        schemaVersion: null,
        appliedCount: null,
      })
      expect(JSON.stringify(failed)).not.toContain("no such table")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("the real listener publishes a metadata snapshot from its initialized database before readiness", async () => {
  const { Server } = await import("../../src/server/server")
  const snapshots: unknown[] = []
  const listener = await Server.listen({
    hostname: "127.0.0.1",
    port: 0,
    onSupportDatabase: (value) => {
      snapshots.push(value)
    },
  })
  try {
    expect(snapshots.at(-1)).toMatchObject({
      availability: "available",
      source: "runtime_snapshot",
      migrationFormat: "current",
    })
    expect(JSON.stringify(snapshots)).not.toContain("private_fixture")
    expect((await fetch(new URL("/global/health", listener.url))).status).toBe(200)
  } finally {
    await listener.stop()
  }
})

test("a rejected diagnostics observer cannot prevent a healthy listener from starting", async () => {
  const { Server } = await import("../../src/server/server")
  const listener = await Server.listen({
    hostname: "127.0.0.1",
    port: 0,
    onSupportDatabase: () => {
      throw new Error("private observer error")
    },
  })
  try {
    expect((await fetch(new URL("/global/health", listener.url))).status).toBe(200)
  } finally {
    await listener.stop()
  }
})
