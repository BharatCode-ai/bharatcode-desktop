import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveWslAcceptanceInvocation, runPackagedWslAcceptance } from "./wsl-acceptance"

const validArguments = [
  "--bharatcode-wsl-acceptance-case",
  "scenario-9",
  "--runtime-manifest",
  "C:\\runtime\\manifest.json",
  "--distribution",
  "BharatCode",
  "--invalid-distribution",
  "InvalidRoot",
  "--missing-prerequisite-distribution",
  "MissingRuntime",
  "--windows-project",
  "C:\\project",
  "--source-sha",
  "93643f9df61651c5922400f04514b991bb4d2098",
  "--acceptance-dir",
  "C:\\acceptance",
] as const

describe("packaged WSL acceptance entrypoint", () => {
  test("leaves the ordinary Desktop path unchanged when the acceptance flag is absent", () => {
    expect(
      resolveWslAcceptanceInvocation(["bharatcode.exe", "--ordinary"], {
        packaged: true,
        platform: "win32",
      }),
    ).toEqual({ kind: "ordinary" })
  })

  test("accepts only the closed packaged Windows invocation", () => {
    expect(
      resolveWslAcceptanceInvocation(validArguments, {
        packaged: true,
        platform: "win32",
      }),
    ).toEqual({
      kind: "acceptance",
      input: {
        acceptanceDirectory: "C:\\acceptance",
        case: "scenario-9",
        distribution: "BharatCode",
        invalidDistribution: "InvalidRoot",
        missingPrerequisiteDistribution: "MissingRuntime",
        runtimeManifest: "C:\\runtime\\manifest.json",
        sourceSha: "93643f9df61651c5922400f04514b991bb4d2098",
        windowsProject: "C:\\project",
      },
    })
  })

  test("fails closed for malformed, unpackaged, and non-Windows acceptance invocations", () => {
    for (const [arguments_, environment] of [
      [["--bharatcode-wsl-acceptance-case", "scenario-9"], { packaged: true, platform: "win32" }],
      [validArguments, { packaged: false, platform: "win32" }],
      [validArguments, { packaged: true, platform: "linux" }],
    ] as const) {
      expect(() => resolveWslAcceptanceInvocation(arguments_, environment)).toThrow()
    }
  })

  test("dispatches the exact flag from the shipped entrypoint before ordinary main", () => {
    const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    const adapterSource = readFileSync(new URL("./wsl-acceptance.ts", import.meta.url), "utf8")
    const dispatch = indexSource.lastIndexOf("resolveWslAcceptanceInvocation")
    const acceptance = indexSource.indexOf('dispatch.kind === "acceptance"')
    const ordinaryMain = indexSource.indexOf("Effect.runFork(main)")

    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(acceptance).toBeGreaterThan(dispatch)
    expect(ordinaryMain).toBeGreaterThan(acceptance)
    expect(adapterSource).toContain('"--bharatcode-wsl-acceptance-case"')
  })

  test("never starts ordinary main after a rejected acceptance invocation", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    expect(source).toContain('dispatch = { kind: "rejected" }')
    expect(source).toContain('else if (dispatch.kind === "ordinary")')
  })

  test("reachable CP5A adapter rejects without producing acceptance output", async () => {
    const root = mkdtempSync(join(tmpdir(), "bharatcode-wsl-cp5a-"))
    try {
      const dispatch = resolveWslAcceptanceInvocation(
        validArguments.map((value) => (value === "C:\\acceptance" ? root : value)),
        { packaged: true, platform: "win32" },
      )
      if (dispatch.kind !== "acceptance") throw new Error("expected acceptance dispatch")
      await expect(runPackagedWslAcceptance(dispatch.input)).rejects.toThrow("adapter is unavailable")
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
