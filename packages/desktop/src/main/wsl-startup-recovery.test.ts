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
      Promise.race([
        recovery.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]),
    ).resolves.toBe("pending")
  })

  test("unknown startup errors project only to start-failed", () => {
    expect(projectWslStartupRecoveryCode(new Error("C:\\private\\repo secret@example.com"))).toBe("start-failed")
    expect(projectWslStartupRecoveryCode(new WslLifecycleFailure("root-user"))).toBe("root-user")
  })

  test("native prompt has only the approved safe actions and copy", async () => {
    const source = await Bun.file(new URL("./windows.ts", import.meta.url)).text()
    const start = source.indexOf("export async function showWslStartupRecoveryDialog")
    const end = source.indexOf("\n}\n", start)
    const prompt = source.slice(start, end + 2)

    expect(start).toBeGreaterThan(-1)
    expect(prompt).toContain('["Retry WSL", "Disable WSL and restart", "Quit"]')
    expect(prompt).toContain('message: "BharatCode could not start its WSL runtime."')
    expect(prompt).toContain("BharatCode did not switch to the Windows runtime automatically.")
    expect(prompt).toContain("Failure category: ${code}")
    expect(prompt).toContain("defaultId: 0")
    expect(prompt).toContain("cancelId: 2")
    expect(prompt).not.toMatch(/error\\.message|selectedDisplayName|distribution|stdout|stderr|path|email/iu)
  })

  test("enabled startup recovers before sidecar readiness and never enters the local fallback branch", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()
    const enabled = source.indexOf("if (wslSnapshot.enabled)")
    const recovery = source.indexOf("await recoverWslStartup(", enabled)
    const localAuthorization = source.indexOf("sidecarAuthorization = createSidecarAuthorizationPolicy", enabled)
    const serverReady = source.indexOf("yield* Deferred.succeed(serverReady", enabled)
    const windowCreation = source.indexOf("mainWindow = createMainWindow", enabled)

    expect(enabled).toBeGreaterThan(-1)
    expect(recovery).toBeGreaterThan(enabled)
    expect(source.slice(recovery, localAuthorization)).toContain("start: () => wslLifecycle!.start()")
    expect(source.slice(recovery, localAuthorization)).toContain("prompt: showWslStartupRecoveryDialog")
    expect(source.slice(recovery, localAuthorization)).toContain("enabled: false")
    expect(source.slice(recovery, localAuthorization)).toContain("expectedRevision: current.revision")
    expect(source.slice(recovery, localAuthorization)).toContain("return relaunchDesktop()")
    expect(source.slice(recovery, localAuthorization)).toContain("quit: quitBeforeStartup")
    expect(localAuthorization).toBeGreaterThan(recovery)
    expect(serverReady).toBeGreaterThan(localAuthorization)
    expect(windowCreation).toBeGreaterThan(serverReady)
  })
})
