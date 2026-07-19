import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const desktopAcceptance = resolve(import.meta.dir, "../../../desktop/scripts/lean-product-core-acceptance.mjs")

describe("lean BharatCode Product Core", () => {
  test("installed CLI and two shared-runtime clients produce scenario 1-5/8 receipts", async () => {
    const child = Bun.spawn(["bun", desktopAcceptance, "--self-check"], {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    const receipt = JSON.parse(stdout)
    expect(receipt.scenarios).toEqual({ 1: "PASS", 2: "PASS", 3: "PASS", 4: "PASS", 5: "PASS", 8: "PASS" })
    expect(receipt.source).toMatch(/^[0-9a-f]{40}$/)
    expect(receipt.testName).toBe("lean-product-core-scenarios-1-5-8")
    expect(receipt.observations).toHaveLength(3)
    expect(
      receipt.observations.every(
        (item: { exitCode: number; failCount: number }) => item.exitCode === 0 && item.failCount === 0,
      ),
    ).toBe(true)
    expect(receipt.observations.find((item: { name: string }) => item.name === "package").passCount).toBeGreaterThan(0)
    expect(receipt.runtime.identity.cli).toBe(receipt.runtime.identity.desktop)
    expect(receipt.runtime.adapters).toEqual({
      cliTui: "createOpencodeClient(@opencode-ai/sdk/v2)",
      desktop: "createSdkForServer(packages/app/src/utils/server)",
      desktopAccount: "createBharatCodeAccountClient(packages/desktop/src/main/bharatcode-auth)",
    })
    expect(
      receipt.runtime.attempts.some((item: { adapter?: string }) => item.adapter === receipt.runtime.adapters.cliTui),
    ).toBe(true)
    expect(
      receipt.runtime.attempts.some((item: { adapter?: string }) => item.adapter === receipt.runtime.adapters.desktop),
    ).toBe(true)
    expect(receipt.runtime.project).toMatch(/project-/)
    expect(receipt.runtime.sessionID).toMatch(/^ses_/)
    expect(receipt.runtime.chatCalls).toBeGreaterThanOrEqual(2)
    expect(receipt.runtime.attempts.length).toBeGreaterThan(0)
    expect(receipt.runtime.shareAttempts).toEqual([])
    expect(receipt.forbiddenAttempts).toEqual([])
    expect(receipt.cleanup).toEqual({ home: true, project: true })
  }, 240_000)
})
