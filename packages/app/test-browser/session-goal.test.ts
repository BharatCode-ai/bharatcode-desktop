import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSessionGoalController,
  goalElapsed,
  goalSetCommand,
  goalToggleCommand,
} from "@/pages/session/composer/session-goal-state"
import type { SessionGoal, SessionGoalUpdate } from "@opencode-ai/sdk/v2/client"

const goal: SessionGoal = {
  text: "Original",
  status: "active",
  created: 1,
  updated: 1,
  accumulated: 50,
  activeSince: 100,
}

test("Goal Mode validates bounded text and preserves pause/resume semantics", () => {
  expect(goalSetCommand("  work  ")).toEqual({ action: "set", text: "work" })
  expect(goalSetCommand("  ")).toBeUndefined()
  expect(goalSetCommand("x".repeat(4001))).toBeUndefined()
  expect(goalToggleCommand(goal)).toEqual({ action: "pause" })
  expect(goalToggleCommand({ ...goal, status: "paused" })).toEqual({ action: "resume" })
  expect(goalToggleCommand({ ...goal, status: "completed" })).toBeUndefined()
  expect(goalToggleCommand({ ...goal, status: "blocked" })).toBeUndefined()
  expect(goalElapsed(goal, 110)).toBe(60)
  expect(goalElapsed(goal, 90)).toBe(50)
  expect(goalElapsed({ ...goal, status: "paused" }, 500)).toBe(50)
})

test("failed updates retain the edit and expose only a safe error flag; duplicate submissions are suppressed", async () => {
  const calls: SessionGoalUpdate[] = []
  let reject!: (error: unknown) => void
  const instance = createRoot((dispose) => ({
    dispose,
    controller: createSessionGoalController({
      key: () => "native:A",
      goal: () => goal,
      update: (command) => {
        calls.push(command)
        return new Promise<void>((_, fail) => {
          reject = fail
        })
      },
    }),
  }))
  const c = instance.controller
  c.edit()
  c.setDraft("Updated")
  const first = c.save()
  await c.save()
  expect(c.state.pending).toBe(true)
  expect(c.state.editing).toBe(true)
  expect(calls).toHaveLength(1)
  reject(new Error("secret callback token and local path"))
  await first
  expect(c.state.error).toBe(true)
  expect(c.state.draft).toBe("Updated")
  expect(c.state.editing).toBe(true)
  expect(c.state.pending).toBe(false)
  expect(JSON.stringify(c.state)).not.toContain("secret")
  instance.dispose()
})

test("successful save and clear use server-confirmed state; switching runtime/session invalidates late completion", async () => {
  const pending: Array<() => void> = []
  const calls: SessionGoalUpdate[] = []
  const instance = createRoot((dispose) => {
    const [key, setKey] = createSignal("native:A")
    return {
      dispose,
      setKey,
      controller: createSessionGoalController({
        key,
        goal: () => goal,
        update: (command) => {
          calls.push(command)
          return new Promise<void>((resolve) => pending.push(resolve))
        },
      }),
    }
  })
  const c = instance.controller
  c.edit()
  c.setDraft("Native")
  const first = c.save()
  instance.setKey("wsl:A")
  c.edit()
  c.setDraft("WSL")
  const second = c.save()
  pending[0]!()
  await first
  expect(c.state.pending).toBe(true)
  expect(c.state.draft).toBe("WSL")
  pending[1]!()
  await second
  expect(c.state.editing).toBe(false)
  expect(c.state.pending).toBe(false)
  const clear = c.run({ action: "clear" })
  expect(calls.at(-1)).toEqual({ action: "clear" })
  pending[2]!()
  await clear
  instance.dispose()
})

test("A to B to A navigation and disposal cannot revive an old save", async () => {
  let resolve!: () => void
  const instance = createRoot((dispose) => {
    const [key, setKey] = createSignal("A")
    return {
      dispose,
      setKey,
      controller: createSessionGoalController({
        key,
        goal: () => goal,
        update: () =>
          new Promise<void>((done) => {
            resolve = done
          }),
      }),
    }
  })
  const c = instance.controller
  c.edit()
  const request = c.save()
  instance.setKey("B")
  instance.setKey("A")
  c.edit()
  c.setDraft("New edit")
  instance.dispose()
  resolve()
  await request
  expect(c.state.editing).toBe(true)
  expect(c.state.draft).toBe("New edit")
})
