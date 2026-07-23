import { describe, expect, test } from "bun:test"
import { WslLifecycleFailure } from "./wsl-lifecycle"
import { projectWslStartupRecoveryCode, recoverWslStartup, type WslStartupRecoveryAction } from "./wsl-startup-recovery"

function terminal(label: string, effects: string[]): Promise<never> {
  effects.push(label)
  return Promise.reject(new Error(`terminal:${label}`))
}

async function waitForEffect(effects: string[], effect: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (effects.includes(effect)) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`effect not observed: ${effect}`)
}

describe("pre-window WSL startup recovery", () => {
  test("successful WSL startup resolves without prompting", async () => {
    const effects: string[] = []
    await recoverWslStartup({
      start: async () => {
        effects.push("start")
      },
      prompt: async () => {
        effects.push("prompt")
        return "quit"
      },
      disableAndRestart: () => terminal("disable", effects),
      quit: () => terminal("quit", effects),
    })
    expect(effects).toEqual(["start"])
  })

  test("retry revalidates through the injected start operation until it succeeds", async () => {
    const effects: string[] = []
    let starts = 0
    await recoverWslStartup({
      start: async () => {
        starts += 1
        effects.push(`start:${starts}`)
        if (starts === 1) throw new WslLifecycleFailure("prerequisite-missing")
      },
      prompt: async (code) => {
        effects.push(`prompt:${code}`)
        return "retry"
      },
      disableAndRestart: () => terminal("disable", effects),
      quit: () => terminal("quit", effects),
    })
    expect(effects).toEqual(["start:1", "prompt:prerequisite-missing", "start:2"])
  })

  test("a failed retry presents the newly classified safe code", async () => {
    const effects: string[] = []
    const actions: WslStartupRecoveryAction[] = ["retry", "quit"]
    let starts = 0
    await expect(
      recoverWslStartup({
        start: async () => {
          starts += 1
          effects.push(`start:${starts}`)
          throw starts === 1 ? new WslLifecycleFailure("connection-lost") : new WslLifecycleFailure("runtime-integrity")
        },
        prompt: async (code) => {
          effects.push(`prompt:${code}`)
          return actions.shift() ?? "quit"
        },
        disableAndRestart: () => terminal("disable", effects),
        quit: () => terminal("quit", effects),
      }),
    ).rejects.toThrow("terminal:quit")
    expect(effects).toEqual(["start:1", "prompt:connection-lost", "start:2", "prompt:runtime-integrity", "quit"])
  })

  test("disable is terminal and a persistence failure keeps recovery available", async () => {
    const effects: string[] = []
    const actions: WslStartupRecoveryAction[] = ["disable-and-restart", "disable-and-restart"]
    let disables = 0
    const recovery = recoverWslStartup({
      start: async () => {
        effects.push("start")
        throw new WslLifecycleFailure("selection-invalid")
      },
      prompt: async (code) => {
        effects.push(`prompt:${code}`)
        return actions.shift() ?? "quit"
      },
      disableAndRestart: async () => {
        disables += 1
        effects.push(`disable:${disables}`)
        if (disables === 1) throw new Error("private persistence detail")
        effects.push("relaunch")
        return new Promise<never>(() => {})
      },
      quit: () => terminal("quit", effects),
    })
    await waitForEffect(effects, "relaunch")
    expect(effects).toEqual([
      "start",
      "prompt:selection-invalid",
      "disable:1",
      "prompt:configuration-failed",
      "disable:2",
      "relaunch",
    ])
    await expect(
      Promise.race([recovery.then(() => "settled", () => "settled"), new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]),
    ).resolves.toBe("pending")
  })

  test("unknown startup errors project only to start-failed", () => {
    expect(projectWslStartupRecoveryCode(new Error("C:\\private\\repo secret@example.com"))).toBe("start-failed")
    expect(projectWslStartupRecoveryCode(new WslLifecycleFailure("root-user"))).toBe("root-user")
  })
})
