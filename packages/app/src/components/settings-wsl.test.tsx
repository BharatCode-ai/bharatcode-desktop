import { describe, expect, test } from "bun:test"
import {
  runWslStatusAction,
  wslCanEnable,
  wslEnableUpdate,
  wslRecoveryActions,
  wslSelectUpdate,
  wslSettingsVisible,
  wslStatusText,
} from "./settings-wsl"
import type { WslSnapshot } from "@/context/platform"

const snapshot: WslSnapshot = {
  enabled: false,
  revision: 8,
  distributions: [
    { displayName: "Ubuntu 24.04", version: 2, selected: false },
    { displayName: "Debian", version: 2, selected: false },
  ],
  status: { phase: "off" },
}

describe("Windows WSL settings", () => {
  test("is visible only for Windows Desktop with the typed snapshot API", () => {
    expect(wslSettingsVisible({ platform: "desktop", os: "windows", getWslSnapshot: async () => snapshot })).toBe(true)
    expect(wslSettingsVisible({ platform: "desktop", os: "linux", getWslSnapshot: async () => snapshot })).toBe(false)
    expect(wslSettingsVisible({ platform: "web", os: "windows" })).toBe(false)
  })

  test("builds revision-bound enable, disable, and selection updates", () => {
    expect(wslCanEnable(snapshot)).toBe(true)
    expect(wslCanEnable({ ...snapshot, distributions: [] })).toBe(false)
    expect(wslEnableUpdate(snapshot, true)).toEqual({
      enabled: true,
      expectedRevision: 8,
      selectedDisplayName: "Ubuntu 24.04",
    })
    expect(wslEnableUpdate({ ...snapshot, enabled: true }, false)).toEqual({ enabled: false, expectedRevision: 8 })
    expect(wslSelectUpdate({ ...snapshot, enabled: true }, "Debian")).toEqual({
      enabled: true,
      expectedRevision: 8,
      selectedDisplayName: "Debian",
    })
  })

  test("renders only safe phase and error-code text", () => {
    expect(wslStatusText({ phase: "running" })).toBe("Running")
    expect(wslStatusText({ phase: "error", code: "selection-invalid" })).toBe("Error: selection-invalid")
  })

  test("contains refresh and retry failures inside the busy and error boundary", async () => {
    const busy: boolean[] = []
    const errors: string[] = []
    const results: WslSnapshot[] = []
    const hooks = {
      setBusy: (value: boolean) => busy.push(value),
      onResult: (value: WslSnapshot) => results.push(value),
      onError: (error: unknown) => errors.push(error instanceof Error ? error.message : String(error)),
    }

    await runWslStatusAction(async () => snapshot, hooks)
    await runWslStatusAction(async () => {
      throw new Error("refresh failed")
    }, hooks)

    expect(busy).toEqual([true, false, true, false])
    expect(results).toEqual([snapshot])
    expect(errors).toEqual(["refresh failed"])
  })

  test("offers Choose, Retry, and Disable for every actionable runtime failure", async () => {
    for (const code of [
      "selection-invalid",
      "root-user",
      "prerequisite-missing",
      "runtime-integrity",
      "path-translation",
      "start-failed",
      "connection-lost",
      "stop-failed",
    ] as const) {
      expect(wslRecoveryActions({ phase: "error", code })).toEqual(["choose", "retry", "disable"])
    }
    expect(wslRecoveryActions({ phase: "running" })).toEqual([])

    const source = await Bun.file(new URL("./settings-wsl.tsx", import.meta.url)).text()
    expect(source).toContain("Choose")
    expect(source).toContain("Retry")
    expect(source).toContain("Disable")
  })
})
