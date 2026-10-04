import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919234912_add_goal_mode",
  up(tx) {
    return Effect.gen(function* () {
      // Some upgraded databases already have the column but not this journal ID.
      // Accept only the exact compatible shape; never discard existing goals or
      // hide unrelated ALTER failures. The runner records completion atomically.
      const existing = yield* tx.get<{
        type: string
        notnull: number
        dflt_value: unknown
        pk: number
        hidden: number
      }>(
        sql`SELECT type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo('session') WHERE lower(name) = 'goal'`,
      )
      if (existing) {
        if (
          existing.type.toLowerCase() !== "text" ||
          existing.notnull !== 0 ||
          existing.dflt_value !== null ||
          existing.pk !== 0 ||
          existing.hidden !== 0
        )
          return yield* Effect.die(new Error("Existing session.goal column is incompatible; database was not changed"))
        return
      }
      yield* tx.run(`ALTER TABLE \`session\` ADD \`goal\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
