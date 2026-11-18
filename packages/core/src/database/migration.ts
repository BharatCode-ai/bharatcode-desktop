export * as DatabaseMigration from "./migration"

import { existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export type RepairOptions = {
  backupPath?: string
}

export function backupDatabase(db: Database, targetPath: string) {
  return Effect.gen(function* () {
    const safePath = targetPath.replaceAll("'", "''")
    yield* db.run(sql.raw(`VACUUM INTO '${safePath}'`))
    if (!existsSync(targetPath)) {
      return yield* Effect.die(new Error(`Backup file was not created at ${targetPath}`))
    }
    const stat = statSync(targetPath)
    if (stat.size === 0) {
      return yield* Effect.die(new Error(`Backup file is empty at ${targetPath}`))
    }
  })
}

function repairSchemaImpl(db: Database, options?: RepairOptions) {
  return Effect.gen(function* () {
    const backupPath =
      options?.backupPath ??
      join(tmpdir(), `bharatcode-migration-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    yield* backupDatabase(db, backupPath)

    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )

    const tables = (yield* db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )).map((t) => t.name.toLowerCase())

    if (!tables.includes("session")) {
      return yield* Effect.die(new Error("Database is not empty and has no session table"))
    }

    // 1. Session table: validate goal column type if present, or add goal column if missing
    const existingGoal = yield* db.get<{
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
      hidden: number
    }>(
      sql`SELECT type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo('session') WHERE lower(name) = 'goal'`,
    )
    if (existingGoal) {
      if (
        existingGoal.type.toLowerCase() !== "text" ||
        existingGoal.notnull !== 0 ||
        existingGoal.dflt_value !== null ||
        existingGoal.pk !== 0 ||
        existingGoal.hidden !== 0
      ) {
        return yield* Effect.die(
          new Error(
            `Existing session.goal column is incompatible (type: ${existingGoal.type}); database was not changed`,
          ),
        )
      }
    } else {
      yield* db.run(sql`ALTER TABLE \`session\` ADD COLUMN \`goal\` text`)
    }

    // Validate and add parent_id if missing (preserving all unknown extra user columns)
    const sessionCols = (yield* db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session')`)).map((c) =>
      c.name.toLowerCase(),
    )
    if (!sessionCols.includes("parent_id")) {
      yield* db.run(sql`ALTER TABLE \`session\` ADD COLUMN \`parent_id\` text`)
    }

    // Mark 20260919234912_add_goal_mode completed only after verified postcondition
    yield* db.run(sql`
      INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
      VALUES ('20260919234912_add_goal_mode', ${Date.now()})
    `)

    // 2. Workspace table: validate existing schema if present; fail closed on partial tables
    if (tables.includes("workspace")) {
      const workspaceCols = (yield* db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('workspace')`)).map(
        (c) => c.name.toLowerCase(),
      )

      const requiredWorkspaceCols = ["id", "project_id", "branch", "directory", "extra"]
      const missingWorkspaceCols = requiredWorkspaceCols.filter((col) => !workspaceCols.includes(col))
      if (missingWorkspaceCols.length > 0) {
        return yield* Effect.die(
          new Error(
            `Existing workspace table is incompatible: missing required columns ${missingWorkspaceCols.join(", ")}; database was not changed`,
          ),
        )
      }

      // Fully valid workspace postcondition verified
      yield* db.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
        VALUES ('20260225215848_workspace', ${Date.now()})
      `)
    }

    // 3. Credential table: validate existing schema if present; fail closed on partial tables
    if (tables.includes("credential")) {
      const credentialCols = (yield* db.all<{ name: string }>(
        sql`SELECT name FROM pragma_table_info('credential')`,
      )).map((c) => c.name.toLowerCase())

      const requiredCredentialCols = ["id", "label", "value"]
      const missingCredentialCols = requiredCredentialCols.filter((col) => !credentialCols.includes(col))
      if (missingCredentialCols.length > 0) {
        return yield* Effect.die(
          new Error(
            `Existing credential table is incompatible: missing required columns ${missingCredentialCols.join(", ")}; database was not changed`,
          ),
        )
      }

      // Fully valid credential postcondition verified
      yield* db.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
        VALUES ('20260611035744_credential', ${Date.now()})
      `)
    }

    // 4. Session workspace_id: validate column if present
    if (sessionCols.includes("workspace_id")) {
      yield* db.run(sql`CREATE INDEX IF NOT EXISTS \`session_workspace_idx\` ON \`session\` (\`workspace_id\`)`)
      yield* db.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
        VALUES ('20260227213759_add_session_workspace_id', ${Date.now()})
      `)
    }
  })
}

export function repairSchema(db: Database, options?: RepairOptions) {
  return lock.withPermit(repairSchemaImpl(db, options))
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        const named = (yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
        )).some((column) => column.name === "name")

        if (named) {
          yield* db.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
        }

        if (!named) {
          const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
            SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE created_at IS NOT NULL
          `)

          for (const entry of entries) {
            const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
            if (!migration) {
              return yield* Effect.die(
                new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
              )
            }
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${Date.now()})
            `)
          }
        }
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
