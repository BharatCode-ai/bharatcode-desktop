import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919234912_add_goal_mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`goal\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
