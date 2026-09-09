import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { availableRecoveryActions, createRecoveryController, type RecoveryView } from "./loading-recovery"

describe("loading recovery UI", () => {
  test("renders only closed recovery labels and disables every action while an operation is in flight", async () => {
    const source = await readFile(path.join(import.meta.dir, "loading.tsx"), "utf8")
    expect(source).toContain("Continue with")
    expect(source).toContain("Retry")
    expect(source).toContain("Start Fresh")
    expect(source).toContain("Repair Database Marker")
    expect(source).toMatch(/disabled=\{[^}]*inFlight/)
    expect(source).not.toMatch(/source\.roots|sourcePath|databasePath|auth\.json|credential/)
  })

  test("preload exposes a closed recovery API and no arbitrary command or path argument", async () => {
    const [preload, types] = await Promise.all([
      readFile(path.join(import.meta.dir, "../preload/index.ts"), "utf8"),
      readFile(path.join(import.meta.dir, "../preload/types.ts"), "utf8"),
    ])
    expect(preload).toContain('ipcRenderer.invoke("recovery:inspect")')
    expect(preload).toContain('ipcRenderer.invoke("recovery:run", action)')
    expect(types).toContain("RecoveryAction")
    const recoveryTypes = types.slice(
      types.indexOf("export type RecoverySource"),
      types.indexOf("export type WslConfig"),
    )
    expect(recoveryTypes).not.toMatch(/(?:path|bytes|credential|command)\s*:/i)
  })

  test("interrupted recovery offers both Retry and marker-independent Start Fresh", () => {
    expect(availableRecoveryActions({ state: "retry", operationID: "5f8c2aef-b4b6-4f21-8f76-d036074888e4" })).toEqual([
      "retry",
      "start-fresh",
    ])
  })

  test("failed actions retain choices, never disclose raw errors, and permit retry", async () => {
    const choice = {
      state: "choose-source" as const,
      sources: [{ id: "good", label: "Existing BharatCode", contentFingerprint: "a".repeat(64) }],
    }
    let view: RecoveryView
    let calls = 0
    const controller = createRecoveryController({
      inspect: async () => choice,
      run: async () => {
        if (++calls === 1) throw new Error("EPERM C:\\private\\token secret-example")
        return { state: "ready" }
      },
      update: (next) => {
        view = next
      },
    })
    await controller.inspect()
    const action = { type: "choose-source" as const, ...choice.sources[0] }
    await controller.run(action)
    expect(view!.status).toEqual(choice)
    expect(view!.busy).toBeNull()
    expect(view!.error).toContain("Try the action again")
    expect(JSON.stringify(view!)).not.toMatch(/private|token|secret-example|corrupt/)
    await controller.run(action)
    expect(view!.status).toEqual({ state: "ready" })
    expect(view!.error).toBeNull()
  })

  test("double submit and refresh cannot race a mutation; interrupted state is re-inspected", async () => {
    let view: RecoveryView
    let reject!: (reason: Error) => void
    let calls = 0
    let inspections = 0
    const controller = createRecoveryController({
      inspect: async () => {
        inspections++
        return { state: "retry", operationID: "operation" }
      },
      run: () => {
        calls++
        return new Promise((_, fail) => {
          reject = fail
        })
      },
      update: (next) => {
        view = next
      },
    })
    const pending = controller.run({ type: "start-fresh", confirmed: true })
    expect(view!.busy).toBe("start-fresh")
    await controller.run({ type: "start-fresh", confirmed: true })
    await controller.inspect()
    expect(calls).toBe(1)
    expect(inspections).toBe(0)
    reject(new Error("private payload"))
    await pending
    expect(view!.status).toEqual({ state: "retry", operationID: "operation" })
    expect(view!.busy).toBeNull()
    expect(inspections).toBe(1)
  })

  test("inspect failure is recoverable and never invents a corrupt diagnosis", async () => {
    let view: RecoveryView
    let fail = true
    const controller = createRecoveryController({
      inspect: async () => {
        if (fail) throw new Error("secret")
        return { state: "ready" }
      },
      run: async () => {
        throw new Error("unused")
      },
      update: (next) => {
        view = next
      },
    })
    await controller.inspect()
    expect(view!.status).toBeNull()
    expect(view!.error).toContain("Check again")
    fail = false
    await controller.inspect()
    expect(view!.status).toEqual({ state: "ready" })
    expect(view!.error).toBeNull()
  })

  test("recovery uses styled actions, busy feedback and wrapping secret-safe errors", async () => {
    const source = await readFile(path.join(import.meta.dir, "loading.tsx"), "utf8")
    expect(source).toContain("@opencode-ai/ui/button")
    expect(source).not.toContain("<button")
    expect(source).toContain('role="alert"')
    expect(source).toContain("aria-busy")
    expect(source).toContain("Check again")
    expect(source).not.toContain('reason: "corrupt"')
    expect(source).not.toContain("whitespace-nowrap")
  })
})
