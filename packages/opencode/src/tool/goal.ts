import { Effect, Schema } from "effect"
import { GoalState } from "@/session/goal-state"
import { Session } from "@/session/session"
import { PartID } from "@/session/schema"
import * as Tool from "./tool"

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } satisfies NonNullable<
  Session.Info["tokens"]
>

const GoalSetParameters = Schema.Struct({
  goal: Schema.String.annotate({
    description: "The durable goal the agent should work toward. Include success checks and user constraints.",
  }),
})

const GoalCompleteParameters = Schema.Struct({
  report: Schema.String.annotate({
    description: "Concise completion report describing what was finished and how the goal was validated.",
  }),
})

const GoalBlockerParameters = Schema.Struct({
  blocker: Schema.String.annotate({
    description: "What is blocking progress and what user input, access, or external condition is needed.",
  }),
  attempted: Schema.optional(
    Schema.String.annotate({
      description: "Briefly describe what was tried before determining the goal is blocked.",
    }),
  ),
})

type GoalMetadata = {
  status: Session.GoalStatus | "inactive"
  goal: string
  elapsed?: number
}

function inactiveResult() {
  return {
    title: "Goal not active",
    output: "No active Goal Mode objective was found for this session.",
    metadata: { status: "inactive", goal: "" } satisfies GoalMetadata,
  }
}

function alreadyActiveResult(goal: Session.Goal) {
  return {
    title: "Goal already active",
    output: [
      "Goal Mode already has an active objective.",
      "",
      `Current goal:\n${goal.text}`,
      "",
      "Continue working toward the current goal, call mcp_goal_complete when it is done, or call mcp_goal_blocker if it is blocked.",
      "Only call mcp_goal_set again after the user explicitly asks to change the objective.",
    ].join("\n"),
    metadata: { status: "active", goal: goal.text, elapsed: goal.accumulated } satisfies GoalMetadata,
  }
}

function publishFinalText(
  sessions: Session.Interface,
  ctx: Tool.Context<GoalMetadata>,
  output: string,
  kind: "goal-complete" | "goal-blocked",
) {
  return sessions
    .updatePart({
      id: PartID.ascending(),
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      type: "text",
      text: output,
      synthetic: true,
      metadata: { kind },
    })
    .pipe(Effect.catchCause(() => Effect.void))
}

function terminalOutput(label: string, goal: Session.Goal, metrics: string) {
  return `${label}\n\nGoal: ${goal.text}\n\n${goal.report}\n\n${metrics}`
}

export const GoalSetTool = Tool.define<typeof GoalSetParameters, GoalMetadata, Session.Service>(
  "mcp_goal_set",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: [
        "Set or replace the current Goal Mode objective for this session.",
        "Use this built-in MCP goal tool when the user gives durable instructions that should keep the agent working beyond a single response.",
        "Write the goal as a clear objective with completion criteria, constraints, and any validation the user requested.",
        "Do not call this tool again while a goal is active unless a newer user message explicitly asks to change the objective.",
      ].join("\n"),
      parameters: GoalSetParameters,
      execute: (params: Schema.Schema.Type<typeof GoalSetParameters>, ctx: Tool.Context<GoalMetadata>) =>
        Effect.gen(function* () {
          const at = Date.now()
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (!session) return inactiveResult()
          if (GoalState.isActive(session.goal)) {
            const msgs = yield* sessions
              .messages({ sessionID: ctx.sessionID })
              .pipe(Effect.catchCause(() => Effect.succeed([])))
            const hasNewerUserMessage = msgs.some(
              (message) => message.info.role === "user" && message.info.time.created > session.goal!.updated,
            )
            if (!hasNewerUserMessage) return alreadyActiveResult(session.goal)
          }

          const goal = GoalState.set(session.goal, { text: params.goal }, at)
          yield* sessions.setGoal({ sessionID: ctx.sessionID, goal })
          return {
            title: "Goal set",
            output: `Goal Mode is now active. Current goal:\n${goal.text}`,
            metadata: { status: "active", goal: goal.text, elapsed: goal.accumulated } satisfies GoalMetadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GoalSetParameters, GoalMetadata>
  }),
)

export const GoalCompleteTool = Tool.define<typeof GoalCompleteParameters, GoalMetadata, Session.Service>(
  "mcp_goal_complete",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: [
        "Report that the active Goal Mode objective is complete.",
        "Use this built-in MCP goal tool instead of ending with plain text when the goal's completion criteria have been satisfied.",
        "Only call it after checking the goal state and including a concise validation/completion report.",
      ].join("\n"),
      parameters: GoalCompleteParameters,
      execute: (params: Schema.Schema.Type<typeof GoalCompleteParameters>, ctx: Tool.Context<GoalMetadata>) =>
        Effect.gen(function* () {
          const at = Date.now()
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (!GoalState.isActive(session?.goal)) return inactiveResult()

          const goal = GoalState.complete(session.goal, { report: params.report }, at)
          yield* sessions.setGoal({ sessionID: ctx.sessionID, goal })
          const metrics = GoalState.formatMetrics(goal, session.tokens ?? EMPTY_TOKENS)
          const output = terminalOutput("Goal Mode marked complete.", goal, metrics)
          yield* publishFinalText(sessions, ctx, output, "goal-complete")
          return {
            title: "Goal complete",
            output,
            metadata: { status: "completed", goal: goal.text, elapsed: goal.accumulated } satisfies GoalMetadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GoalCompleteParameters, GoalMetadata>
  }),
)

export const GoalBlockerTool = Tool.define<typeof GoalBlockerParameters, GoalMetadata, Session.Service>(
  "mcp_goal_blocker",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: [
        "Report that the active Goal Mode objective is blocked.",
        "Use this built-in MCP goal tool instead of ending with plain text when no useful progress can continue without user input, access, or an external condition.",
        "State the blocker, what was tried, and the smallest useful next input needed from the user.",
      ].join("\n"),
      parameters: GoalBlockerParameters,
      execute: (params: Schema.Schema.Type<typeof GoalBlockerParameters>, ctx: Tool.Context<GoalMetadata>) =>
        Effect.gen(function* () {
          const at = Date.now()
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (!GoalState.isActive(session?.goal)) return inactiveResult()

          const goal = GoalState.block(session.goal, params, at)
          yield* sessions.setGoal({ sessionID: ctx.sessionID, goal })
          const metrics = GoalState.formatMetrics(goal, session.tokens ?? EMPTY_TOKENS)
          const output = terminalOutput("Goal Mode marked blocked.", goal, metrics)
          yield* publishFinalText(sessions, ctx, output, "goal-blocked")
          return {
            title: "Goal blocked",
            output,
            metadata: { status: "blocked", goal: goal.text, elapsed: goal.accumulated } satisfies GoalMetadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GoalBlockerParameters, GoalMetadata>
  }),
)
