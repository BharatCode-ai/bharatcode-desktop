export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

// Shared storage/wire contract. Keep identifiers stable for the existing SDK.
export const Status = Schema.Literals(["active", "paused", "completed", "blocked"]).annotate({
  identifier: "SessionGoalStatus",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  text: Schema.String,
  status: Status,
  created: NonNegativeInt,
  updated: NonNegativeInt,
  accumulated: NonNegativeInt,
  activeSince: optional(NonNegativeInt),
  completed: optional(NonNegativeInt),
  report: optional(Schema.String),
}).annotate({ identifier: "SessionGoal" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
