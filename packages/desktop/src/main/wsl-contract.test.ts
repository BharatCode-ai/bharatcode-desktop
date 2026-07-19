import { describe, expect, test } from "bun:test"
import {
  applyWslConfigurationUpdate,
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
