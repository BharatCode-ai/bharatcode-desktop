import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelID, ProviderID } from "@/provider/schema"
import { GoalState } from "@/session/goal-state"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { GoalBlockerTool, GoalCompleteTool, GoalSetTool } from "@/tool/goal"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Bus.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  RuntimeFlags.layer({}),
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(layer)

function ctx(sessionID: SessionID, messageID = MessageID.ascending()) {
  return {
    sessionID,
    messageID,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function assistantMessage(sessionID: SessionID): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    parentID: MessageID.ascending(),
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("test-model"),
    providerID: ProviderID.make("test-provider"),
    time: { created: Date.now() },
    sessionID,
  }
}

describe("tool.goal", () => {
  it.instance("goal complete returns a model-facing result when no goal is active", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const tool = yield* GoalCompleteTool
      const def = yield* tool.init()

      const result = yield* def.execute({ report: "Done." }, ctx(chat.id))

      expect(result.title).toBe("Goal not active")
      expect(result.output).toContain("No active Goal Mode objective")
    }),
  )

  it.instance("goal complete marks the active goal completed and returns metrics", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const setTool = yield* GoalSetTool
      const setDef = yield* setTool.init()
      const completeTool = yield* GoalCompleteTool
      const completeDef = yield* completeTool.init()

      yield* setDef.execute({ goal: "Ship Goal Mode with typecheck" }, ctx(chat.id))
      const result = yield* completeDef.execute({ report: "Validated with typecheck." }, ctx(chat.id))
      const updated = yield* sessions.get(chat.id)

      expect(result.title).toBe("Goal complete")
      expect(result.output).toContain("Goal Mode metrics:")
      expect(result.output).toContain("- Elapsed:")
      expect(result.output).toContain("- Tokens:")
      expect(updated.goal?.status).toBe("completed")
      expect(updated.goal?.text).toBe("Ship Goal Mode with typecheck")
      expect(updated.goal?.report).toBe("Validated with typecheck.")
    }),
  )

  it.instance("goal complete refuses paused goals without changing their state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const setTool = yield* GoalSetTool
      const setDef = yield* setTool.init()
      const completeTool = yield* GoalCompleteTool
      const completeDef = yield* completeTool.init()

      yield* setDef.execute({ goal: "Ship Goal Mode with typecheck" }, ctx(chat.id))
      const active = (yield* sessions.get(chat.id)).goal
      yield* sessions.setGoal({ sessionID: chat.id, goal: GoalState.pause(active!, Date.now()) })

      const result = yield* completeDef.execute({ report: "Done." }, ctx(chat.id))
      const updated = yield* sessions.get(chat.id)

      expect(result.title).toBe("Goal not active")
      expect(updated.goal?.status).toBe("paused")
      expect(updated.goal?.report).toBeUndefined()
    }),
  )

  it.instance("goal terminal tools write a visible final text part with metrics", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const assistant = yield* sessions.updateMessage(assistantMessage(chat.id))
      const setTool = yield* GoalSetTool
      const setDef = yield* setTool.init()
      const completeTool = yield* GoalCompleteTool
      const completeDef = yield* completeTool.init()

      yield* setDef.execute({ goal: "Ship Goal Mode with visible completion" }, ctx(chat.id))
      yield* completeDef.execute({ report: "Validated with focused tests." }, ctx(chat.id, assistant.id))

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const updatedAssistant = messages.find((message) => message.info.id === assistant.id)
      const text = updatedAssistant?.parts.find(
        (part): part is MessageV2.TextPart => part.type === "text" && part.metadata?.kind === "goal-complete",
      )

      expect(text?.synthetic).toBe(true)
      expect(text?.text).toContain("Goal Mode marked complete.")
      expect(text?.text).toContain("Goal: Ship Goal Mode with visible completion")
      expect(text?.text).toContain("Validated with focused tests.")
      expect(text?.text).toContain("Goal Mode metrics:")
    }),
  )

  it.instance("goal blocker refuses non-active goals", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const setTool = yield* GoalSetTool
      const setDef = yield* setTool.init()
      const blockerTool = yield* GoalBlockerTool
      const blockerDef = yield* blockerTool.init()

      yield* setDef.execute({ goal: "Ship Goal Mode with typecheck" }, ctx(chat.id))
      const active = (yield* sessions.get(chat.id)).goal
      yield* sessions.setGoal({ sessionID: chat.id, goal: GoalState.complete(active!, { report: "Done." }, Date.now()) })

      const result = yield* blockerDef.execute({ blocker: "Need user input" }, ctx(chat.id))
      const updated = yield* sessions.get(chat.id)

      expect(result.title).toBe("Goal not active")
      expect(updated.goal?.status).toBe("completed")
      expect(updated.goal?.report).toBe("Done.")
    }),
  )
})
