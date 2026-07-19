import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { availableRecoveryActions } from "./loading-recovery"

describe("loading recovery UI", () => {
  test("renders only closed recovery labels and disables every action while an operation is in flight", async () => {
    const source = await readFile(path.join(import.meta.dir, "loading.tsx"), "utf8")
    expect(source).toContain("Choose Source")
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
})
