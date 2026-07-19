import { describe, expect, test } from "bun:test"
import { wslEnableUpdate, wslSelectUpdate, wslSettingsVisible, wslStatusText } from "./settings-wsl"
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
})
