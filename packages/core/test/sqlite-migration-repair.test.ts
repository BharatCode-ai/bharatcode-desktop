import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

async function safeRm(dir: string) {
  for (let i = 0; i < 15; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

test("repairSchema creates missing goal and parent_id columns without dropping existing chat data", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()

      // Partially populated legacy database missing goal and parent_id
      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text)`)
      yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)`)
      yield* db.run(sql`INSERT INTO session (id, title) VALUES ('ses_1', 'legacy chat')`)
      yield* db.run(sql`INSERT INTO message (id, session_id, data) VALUES ('msg_1', 'ses_1', 'legacy message')`)

      yield* DatabaseMigration.repairSchema(db)

      // Ensure existing data was preserved
      const sessions = yield* db.all<{ id: string; title: string; goal: string | null; parent_id: string | null }>(
        sql`SELECT id, title, goal, parent_id FROM session`,
      )
      expect(sessions).toEqual([{ id: "ses_1", title: "legacy chat", goal: null, parent_id: null }])

      const messages = yield* db.all<{ id: string; session_id: string; data: string }>(
        sql`SELECT id, session_id, data FROM message`,
      )
      expect(messages).toEqual([{ id: "msg_1", session_id: "ses_1", data: "legacy message" }])

      // Ensure goal and parent_id columns now exist
      const sessionCols = (yield* db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session')`)).map(
        (c) => c.name.toLowerCase(),
      )
      expect(sessionCols).toContain("goal")
      expect(sessionCols).toContain("parent_id")

      // Unrelated migrations are NOT pre-marked complete
      const completed = (yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)).map((m) => m.id)
      expect(completed).toContain("20260919234912_add_goal_mode")
      expect(completed).not.toContain("20260225215848_workspace")
      expect(completed).not.toContain("20260611035744_credential")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})

test("repairSchema preserves existing goals and values", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()

      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text, goal text)`)
      yield* db.run(sql`INSERT INTO session VALUES ('ses_goal', 'goal chat', 'user goal preserved')`)

      yield* DatabaseMigration.repairSchema(db)

      const session = yield* db.get<{ id: string; goal: string }>(
        sql`SELECT id, goal FROM session WHERE id = 'ses_goal'`,
      )
      expect(session).toEqual({ id: "ses_goal", goal: "user goal preserved" })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})

test("repairSchema creates non-locking hot backup when backupPath is provided", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bharatcode-backup-test-"))
  const dbFile = path.join(directory, "main.sqlite")
  const backupFile = path.join(directory, "backup.sqlite")

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal text)`)
        yield* db.run(sql`INSERT INTO session VALUES ('ses_backup', 'backup goal')`)

        yield* DatabaseMigration.repairSchema(db, { backupPath: backupFile })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: dbFile })), Effect.scoped),
    )

    expect(existsSync(backupFile)).toBe(true)

    // Inspect the backup file to verify it is valid and has data
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        const row = yield* db.get<{ id: string; goal: string }>(
          sql`SELECT id, goal FROM session WHERE id = 'ses_backup'`,
        )
        expect(row).toEqual({ id: "ses_backup", goal: "backup goal" })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: backupFile })), Effect.scoped),
    )
  } finally {
    await safeRm(directory)
  }
})

test("repairSchema fails closed and throws immediately if backup fails", async () => {
  const nonExistentPath = path.join(tmpdir(), "nonexistent_dir_99999", "sub", "backup.sqlite")

  let threw = false
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal text)`)
        yield* DatabaseMigration.repairSchema(db, { backupPath: nonExistentPath })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
})

test("repairSchema fails closed and throws when session.goal is incompatible INTEGER", async () => {
  let threw = false
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal INTEGER)`)
        yield* DatabaseMigration.repairSchema(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  } catch (error: any) {
    threw = true
    expect(String(error)).toContain("incompatible")
  }
  expect(threw).toBe(true)
})

test("repairSchema fails closed when existing workspace table is missing required columns (Probe 1)", async () => {
  let threw = false
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal text)`)
        // Probe 1: existing workspace(id, type, project_id, time_used) missing branch, directory, extra
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY, type text, project_id text, time_used integer)`)
        yield* DatabaseMigration.repairSchema(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  } catch (error: any) {
    threw = true
    expect(String(error)).toContain("incompatible")
  }
  expect(threw).toBe(true)
})

test("repairSchema fails closed when existing credential table is missing required columns (Probe 2)", async () => {
  let threw = false
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, goal text)`)
        // Probe 2: existing credential(id) missing label, value
        yield* db.run(sql`CREATE TABLE credential (id text PRIMARY KEY)`)
        yield* DatabaseMigration.repairSchema(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  } catch (error: any) {
    threw = true
    expect(String(error)).toContain("incompatible")
  }
  expect(threw).toBe(true)
})

test("repairSchema preserves unknown extra user columns on existing tables", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text, custom_user_field text)`)
      yield* db.run(sql`INSERT INTO session VALUES ('ses_custom', 'custom title', 'my custom value')`)

      yield* DatabaseMigration.repairSchema(db)

      const row = yield* db.get<{
        id: string
        title: string
        custom_user_field: string
        goal: string | null
        parent_id: string | null
      }>(sql`SELECT id, title, custom_user_field, goal, parent_id FROM session WHERE id = 'ses_custom'`)
      expect(row).toEqual({
        id: "ses_custom",
        title: "custom title",
        custom_user_field: "my custom value",
        goal: null,
        parent_id: null,
      })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})

test("repairSchema only reconciles proven migrations and does not pre-mark unrelated migrations", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text)`)

      yield* DatabaseMigration.repairSchema(db)

      const migrations = yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)
      // Only 20260919234912_add_goal_mode is proven; workspace and credential must NOT be pre-marked!
      expect(migrations.length).toBe(1)
      expect(migrations[0]?.id).toBe("20260919234912_add_goal_mode")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})

test("repairSchema reconciles schema drift so subsequent real migrations succeed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bharatcode-fallback-test-"))
  const dbFile = path.join(directory, "fallback.sqlite")

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        // Legacy database with prior migrations applied, but missing 20260919234912_add_goal_mode
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)`)
        yield* db.run(sql`INSERT INTO session VALUES ('ses_recovery', 'recovery title')`)
        yield* db.run(sql`INSERT INTO message VALUES ('msg_recovery', 'ses_recovery', 'hello recovered world')`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)

        // Mark all migrations except goal migration completed
        for (const m of migrations) {
          if (m.id !== "20260919234912_add_goal_mode") {
            yield* db.run(sql`INSERT INTO migration VALUES (${m.id}, 1)`)
          }
        }

        // Repair schema drift first
        yield* DatabaseMigration.repairSchema(db)

        // Then apply succeeds
        yield* DatabaseMigration.apply(db)

        // Session and message are preserved and new schema is intact
        const session = yield* db.get<{ id: string; title: string; goal: string | null; parent_id: string | null }>(
          sql`SELECT id, title, goal, parent_id FROM session WHERE id = 'ses_recovery'`,
        )
        expect(session).toEqual({ id: "ses_recovery", title: "recovery title", goal: null, parent_id: null })

        const message = yield* db.get<{ id: string; data: string }>(
          sql`SELECT id, data FROM message WHERE id = 'msg_recovery'`,
        )
        expect(message).toEqual({ id: "msg_recovery", data: "hello recovered world" })

        // Re-running apply is a safe no-op
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: dbFile })), Effect.scoped),
    )
  } finally {
    await safeRm(directory)
  }
})
