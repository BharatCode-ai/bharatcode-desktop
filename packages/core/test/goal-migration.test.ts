import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import goal from "../src/database/migration/20260919234912_add_goal_mode"

for (const journal of ["empty", "partial", "complete"]) {
  test(`goal upgrade preserves chats and existing goal with ${journal} journal across repeated initialization`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal text)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)`)
        yield* db.run(sql`INSERT INTO session VALUES ('existing', 'keep this goal')`)
        yield* db.run(sql`INSERT INTO message VALUES ('msg', 'existing', 'keep this chat')`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        if (journal !== "empty")
          yield* db.run(
            sql`INSERT INTO migration VALUES (${journal === "complete" ? goal.id : "earlier_migration"}, 1)`,
          )
        yield* DatabaseMigration.applyOnly(db, [goal])
        yield* DatabaseMigration.applyOnly(db, [goal])
        expect(yield* db.all(sql`SELECT * FROM session`)).toEqual([{ id: "existing", goal: "keep this goal" }])
        expect(yield* db.all(sql`SELECT * FROM message`)).toEqual([
          { id: "msg", session_id: "existing", data: "keep this chat" },
        ])
        expect(yield* db.get(sql`SELECT count(*) AS n FROM migration WHERE id = ${goal.id}`)).toEqual({ n: 1 })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })
}

test("goal upgrade adds the missing column without changing a session", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO session VALUES ('existing')`)
      yield* DatabaseMigration.applyOnly(db, [goal])
      expect(yield* db.get(sql`SELECT * FROM session`)).toEqual({ id: "existing", goal: null })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})

for (const definition of [
  "goal integer",
  "goal text NOT NULL",
  "goal text DEFAULT 'wrong'",
  "goal text GENERATED ALWAYS AS (id) VIRTUAL",
]) {
  test(`goal upgrade rejects incompatible ${definition} without marking complete`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql.raw(`CREATE TABLE session (id text PRIMARY KEY, ${definition})`))
        const result = yield* DatabaseMigration.applyOnly(db, [goal]).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(yield* db.all(sql`SELECT * FROM migration`)).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })
}

test("real startup migrates an existing on-disk goal once and reopens with chat data intact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bharatcode-goal-upgrade-"))
  const filename = path.join(directory, "fixture.sqlite")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal text)`)
        yield* db.run(sql`INSERT INTO session VALUES ('existing-chat', 'existing goal')`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        for (const migration of migrations.filter((item) => item.id !== goal.id))
          yield* db.run(sql`INSERT INTO migration VALUES (${migration.id}, 1)`)
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
    )
    // A fresh connection exercises the next launch, not only a repeated call.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT * FROM session`)).toEqual({ id: "existing-chat", goal: "existing goal" })
        expect(yield* db.get(sql`SELECT count(*) AS n FROM migration WHERE id = ${goal.id}`)).toEqual({ n: 1 })
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
