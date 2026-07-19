import { describe, expect, test } from "bun:test"
import {
  applyWslConfigurationUpdate,
  parseWslConfigurationUpdate,
  parseStoredWslState,
  toWslSnapshot,
  WslRevisionConflict,
  type WslMainDistribution,
} from "./wsl-contract"

const privateDistribution: WslMainDistribution = {
  displayName: "Ubuntu 24.04",
  version: 2,
  running: true,
  instanceId: "{11111111-2222-3333-4444-555555555555}",
  instanceIdSha256: "a".repeat(64),
  user: "private-user",
  uid: 1000,
}

describe("lean WSL renderer contract", () => {
  test("projects only enabled, revision, display names, version, selection, and safe status", () => {
    const snapshot = toWslSnapshot({
      stored: { schema: 1, enabled: true, revision: 7, selectedDisplayName: "Ubuntu 24.04" },
      distributions: [privateDistribution, { ...privateDistribution, displayName: "Legacy", version: 1 }],
      status: { phase: "ready" },
      privateRuntime: {
        authorization: "Basic private-credential",
        artifactSha256: "b".repeat(64),
        lifecycleId: "private-lifecycle",
        processId: 8123,
      },
    })

    expect(snapshot).toEqual({
      enabled: true,
      revision: 7,
      selectedDisplayName: "Ubuntu 24.04",
      distributions: [{ displayName: "Ubuntu 24.04", version: 2, selected: true }],
      status: { phase: "ready" },
    })

    const serialized = JSON.stringify(snapshot)
    for (const forbidden of [
      "instanceId",
      "instanceIdSha256",
      "private-user",
      "uid",
      "authorization",
      "private-credential",
      "artifactSha256",
      "lifecycleId",
      "processId",
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test("accepts only the closed safe persisted state", () => {
    expect(parseStoredWslState(undefined)).toEqual({ schema: 1, enabled: false, revision: 0 })
    expect(parseStoredWslState({ schema: 1, enabled: true, revision: 4, selectedDisplayName: "Debian" })).toEqual({
      schema: 1,
      enabled: true,
      revision: 4,
      selectedDisplayName: "Debian",
    })

    for (const invalid of [
      { schema: 1, enabled: true, revision: 4, selectedDisplayName: "Debian", uid: 1000 },
      { schema: 1, enabled: true, revision: -1, selectedDisplayName: "Debian" },
      { schema: 1, enabled: true, revision: 1, selectedDisplayName: "bad/name" },
      { schema: 1, enabled: true, revision: 1 },
      { schema: 2, enabled: false, revision: 0 },
    ]) {
      expect(parseStoredWslState(invalid)).toEqual({ schema: 1, enabled: false, revision: 0 })
    }
  })

  test("rejects private identity recursively across every renderer-facing WSL surface", async () => {
    const privateFields = [
      "instanceId",
      "instanceIdSha256",
      "user",
      "username",
      "uid",
      "authorization",
      "credential",
      "artifactSha256",
      "lifecycleId",
      "processId",
    ]
    for (const field of privateFields) {
      expect(() =>
        parseWslConfigurationUpdate({
          enabled: true,
          expectedRevision: 1,
          selectedDisplayName: "Debian",
          [field]: "private-sentinel",
        }),
      ).toThrow("Invalid WSL configuration update")
    }

    const sources = await Promise.all([
      Bun.file(new URL("./ipc.ts", import.meta.url)).text(),
      Bun.file(new URL("../preload/index.ts", import.meta.url)).text(),
      Bun.file(new URL("../renderer/index.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../../app/src/context/platform.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../../app/src/components/settings-wsl.tsx", import.meta.url)).text(),
    ])
    const between = (source: string, startMarker: string, endMarker: string) => {
      const start = source.indexOf(startMarker)
      const end = source.indexOf(endMarker)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      return source.slice(start, end)
    }
    const surfaces = [
      between(sources[0], 'ipcMain.handle("wsl:get-snapshot"', 'ipcMain.handle("get-display-backend"'),
      between(sources[1], "getWslSnapshot:", "getDisplayBackend:"),
      between(sources[2], "getWslSnapshot:", "getDefaultServer:"),
      between(sources[3], "export type WslErrorCode", "export type Platform"),
      sources[4],
    ]
    for (const surface of surfaces) {
      for (const field of privateFields) {
        expect(surface).not.toMatch(new RegExp(`\\b${field}\\??\\s*:`))
      }
    }
    expect(between(sources[2], "getWslSnapshot:", "getDefaultServer:")).not.toMatch(
      /storeSet|localStorage|sessionStorage/,
    )
    expect(sources[4]).not.toMatch(/storeSet|localStorage|sessionStorage/)
  })

  test("increments exact revisions and rejects stale configuration writes", () => {
    const state = { schema: 1 as const, enabled: false, revision: 3 }
    expect(
      applyWslConfigurationUpdate(state, {
        enabled: true,
        expectedRevision: 3,
        selectedDisplayName: "Ubuntu 24.04",
      }),
    ).toEqual({ schema: 1, enabled: true, revision: 4, selectedDisplayName: "Ubuntu 24.04" })
    expect(applyWslConfigurationUpdate(state, { enabled: false, expectedRevision: 3 })).toEqual({
      schema: 1,
      enabled: false,
      revision: 4,
    })
    expect(() => applyWslConfigurationUpdate(state, { enabled: false, expectedRevision: 2 })).toThrow(
      WslRevisionConflict,
    )
  })
})
