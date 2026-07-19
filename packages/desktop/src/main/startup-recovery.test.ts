import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { createStartupRecovery, parseRecoveryPayload, type RecoveryPayload } from "./startup-recovery"

describe("Desktop startup recovery", () => {
  test("uses only fixed CLI operations and closed IDs, fingerprints, and confirmation flags", async () => {
    const calls: readonly string[][] = []
    const recorded = calls as string[][]
    const responses: RecoveryPayload[] = [
      {
        state: "choose-source",
        sources: [{ id: "legacy-1", label: "Existing BharatCode data", contentFingerprint: "a".repeat(64) }],
      },
      { state: "ready" },
    ]
    const recovery = createStartupRecovery({
      executable: "/fixed/resources/bharatcode-opencode-cli",
      invoke: async (executable, args) => {
        expect(executable).toBe("/fixed/resources/bharatcode-opencode-cli")
        recorded.push([...args])
        return `${JSON.stringify(responses.shift())}\n`
      },
    })

    const status = await recovery.inspect()
    if (status.state !== "choose-source") throw new Error("expected choice")
    await recovery.run({
      type: "choose-source",
      id: status.sources[0]!.id,
      contentFingerprint: status.sources[0]!.contentFingerprint,
    })

    expect(calls).toEqual([
      ["recovery", "status", "--json"],
      ["recovery", "choose-source", "--id", "legacy-1", "--content-fingerprint", "a".repeat(64), "--json"],
    ])
    expect(calls.flat().join(" ")).not.toMatch(/\/home|auth\.json|bharatcode\.db|credential/i)
  })

  test("deduplicates repeated actions while in flight and converges on one result", async () => {
    let resolve!: (value: string) => void
    let invokes = 0
    const recovery = createStartupRecovery({
      executable: "/fixed/cli",
      invoke: () => {
        invokes++
        return new Promise<string>((done) => (resolve = done))
      },
    })
    const action = { type: "retry", operationID: "5f8c2aef-b4b6-4f21-8f76-d036074888e4" } as const
    const first = recovery.run(action)
    const second = recovery.run(action)
    expect(recovery.inFlight()).toBe(true)
    expect(invokes).toBe(1)
    resolve(JSON.stringify({ state: "ready" }))
    expect(await first).toEqual({ state: "ready" })
    expect(await second).toEqual({ state: "ready" })
    expect(recovery.inFlight()).toBe(false)
  })

  test("holds startup until a recovery action reaches ready", async () => {
    const recovery = createStartupRecovery({
      executable: "/fixed/cli",
      invoke: async (_executable, args) =>
        JSON.stringify(args[1] === "status" ? { state: "start-fresh", reason: "no-source" } : { state: "ready" }),
    })
    const status = await recovery.inspect()
    let started = false
    const gate = recovery.waitUntilReady(status).then(() => (started = true))
    await Promise.resolve()
    expect(started).toBe(false)
    await recovery.run({ type: "start-fresh", confirmed: true })
    await gate
    expect(started).toBe(true)
  })

  test("fails closed on paths, credentials, malformed JSON, and unknown result fields", () => {
    for (const value of [
      { state: "ready", path: "/secret" },
      { state: "retry", operationID: "not-a-uuid" },
      { state: "choose-source", sources: [{ id: "x", label: "x", contentFingerprint: "bad", path: "/x" }] },
      { state: "ready", credential: "token" },
    ]) {
      expect(() => parseRecoveryPayload(JSON.stringify(value))).toThrow("invalid recovery result")
    }
    expect(() => parseRecoveryPayload("not-json")).toThrow("invalid recovery result")
  })

  test("rejects renderer-supplied paths and unknown action fields before invoking the CLI", async () => {
    let invoked = false
    const recovery = createStartupRecovery({
      executable: "/fixed/cli",
      invoke: async () => {
        invoked = true
        return JSON.stringify({ state: "ready" })
      },
    })
    expect(() =>
      recovery.run({
        type: "start-fresh",
        confirmed: true,
        path: "/attacker",
      } as never),
    ).toThrow("invalid recovery result")
    expect(invoked).toBe(false)
  })

  test("production composition gates account and sidecar startup on the packaged exact CLI", async () => {
    const [main, ipc] = await Promise.all([
      readFile(path.join(import.meta.dir, "index.ts"), "utf8"),
      readFile(path.join(import.meta.dir, "ipc.ts"), "utf8"),
    ])
    expect(main).toContain("bundledRecoveryExecutable(desktopResourcesPath())")
    const gate = main.indexOf("const recoveryStatus = yield* Effect.promise(() => startupRecovery.inspect())")
    const account = main.indexOf("accountClient = createBharatCodeAccountClient")
    const sidecar = main.indexOf("spawnLocalServer(hostname")
    expect(gate).toBeGreaterThan(0)
    expect(account).toBeGreaterThan(gate)
    expect(sidecar).toBeGreaterThan(gate)
    expect(ipc).toContain("deps.runRecovery(parseRecoveryAction(action))")
  })
})
