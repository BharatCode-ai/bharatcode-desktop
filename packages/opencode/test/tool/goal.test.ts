import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { GoalCompleteTool, GoalSetTool } from "@/tool/goal"
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

function ctx(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
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
})
