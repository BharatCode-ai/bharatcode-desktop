import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"

export type SupportDatabaseMetadata = Effect.Success<ReturnType<typeof captureSupportDatabase>>

// Called once after the owner's normal database initialization/migrations.
// Exporting the resulting snapshot never opens or queries SQLite.
export function captureSupportDatabase() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const schema = yield* database.db.get<{ schema_version: number }>(sql`PRAGMA schema_version`)
    const journal = yield* database.db.get<{ count: number; latest: string | null }>(sql`
      SELECT COUNT(*) AS count,
        MAX(CASE WHEN length(id) >= 15 AND substr(id,15,1) = '_'
          AND substr(id,1,14) NOT GLOB '*[^0-9]*' THEN substr(id,1,14) END) AS latest
      FROM migration
    `)
    return {
      availability: "available" as const,
      source: "runtime_snapshot" as const,
      capturedAt: new Date().toISOString(),
      schemaVersion: schema?.schema_version ?? null,
      migrationFormat: "current" as const,
      appliedCount: journal?.count ?? null,
      latestMigration: journal?.latest ? Number(journal.latest) : null,
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        availability: "unavailable" as const,
        source: "runtime_snapshot" as const,
        capturedAt: new Date().toISOString(),
        schemaVersion: null,
        migrationFormat: "unknown" as const,
        appliedCount: null,
        latestMigration: null,
      }),
    ),
  )
}
