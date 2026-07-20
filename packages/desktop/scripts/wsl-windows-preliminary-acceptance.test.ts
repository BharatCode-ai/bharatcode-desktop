import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { runPreliminaryWindowsAcceptance } from "./wsl-windows-preliminary-acceptance.mjs"

const sourceSha = "9".repeat(40)
const desktopSha256 = "a".repeat(64)
const manifestSha256 = "b".repeat(64)
const runtimeSha256 = "c".repeat(64)
const distroSha256 = createHash("sha256").update("Ubuntu 24.04").digest("hex")
const userSha256 = createHash("sha256").update("alice").digest("hex")
const completedAt = "2026-07-20T00:00:00.000Z"
const argv = [
  "--desktop-exe",
  "C:\\acceptance\\BharatCode Beta.exe",
  "--runtime-manifest",
  "C:\\acceptance\\manifest.json",
  "--distribution",
  "Ubuntu 24.04",
  "--invalid-distribution",
  "Invalid Root",
  "--missing-prerequisite-distribution",
  "Missing Tool",
  "--windows-project",
  "C:\\acceptance\\project",
  "--source-sha",
  sourceSha,
  "--acceptance-dir",
  "C:\\acceptance\\output",
]
const env = {
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "Windows",
  GITHUB_RUN_ID: "123456789",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_REPOSITORY: "BharatCode-ai/bharatcode-desktop",
  GITHUB_REF: "refs/heads/dev",
  GITHUB_SHA: sourceSha,
  GITHUB_WORKFLOW_REF:
    "BharatCode-ai/bharatcode-desktop/.github/workflows/bharatcode-preliminary-unsigned-wsl.yml@refs/heads/dev",
}

type CaseName = "scenario-9" | "scenario-10-before-restart" | "scenario-10-after-restart"

function observation(name: CaseName) {
  const checks =
    name === "scenario-9"
      ? {
          authenticated_loopback: true,
          inside_selected_distro: true,
          non_root: true,
          packaged_desktop: true,
          packaged_runtime: true,
          project_round_trip: true,
          source_identity: true,
          storage_inside_distro: true,
          unauthenticated_rejected: true,
        }
      : name === "scenario-10-before-restart"
        ? {
            credentials_main_only: true,
            harness_processes_gone: true,
            invalid_distribution_recovery: true,
            missing_prerequisite_recovery: true,
            one_reconnect: true,
            ordinary_stop: true,
            repeated_crash_visible: true,
            restart: true,
            unrelated_process_preserved: true,
          }
        : { harness_processes_gone: true, ordinary_stop: true, persisted_selection: true }
  return {
    schema: "bharatcode-wsl-packaged-case-v1",
    case: name,
    source_sha: sourceSha,
    desktop_sha256: desktopSha256,
    runtime_manifest_sha256: manifestSha256,
    manifest_source_sha: sourceSha,
    executed_source_sha: sourceSha,
    manifest_runtime_sha256: runtimeSha256,
    executed_runtime_sha256: runtimeSha256,
    distro_sha256: distroSha256,
    user_sha256: userSha256,
    uid: 1000,
    wsl_version: 2,
    checks,
  }
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    env,
    now: () => new Date(completedAt),
    executeCase: async ({ case: name }: { case: CaseName }) => observation(name),
    runHarness: async (
      input: string[],
      options: { env: Record<string, string>; runCase: (value: { case: CaseName }) => unknown },
    ) => {
      expect(input).toEqual(argv)
      expect(options.env.GITHUB_ACTIONS).toBe("false")
      await options.runCase({ case: "scenario-9" })
      await options.runCase({ case: "scenario-10-before-restart" })
      await options.runCase({ case: "scenario-10-after-restart" })
      return { authority: "DIAGNOSTIC", receiptPath: undefined, digestPath: undefined }
    },
    ...overrides,
  }
}

describe("preliminary unsigned WSL observation adapter", () => {
  test("projects only observations accepted by the unchanged diagnostic harness", async () => {
    const result = await runPreliminaryWindowsAcceptance(argv, dependencies())
    expect(result).toEqual({
      authority: "PRELIMINARY_UNSIGNED",
      evidence: {
        source_sha: sourceSha,
        desktop_sha256: desktopSha256,
        runtime_manifest_sha256: manifestSha256,
        runtime: {
          manifest_source_sha: sourceSha,
          executed_source_sha: sourceSha,
          manifest_sha256: runtimeSha256,
          executed_sha256: runtimeSha256,
        },
        identity: { distro_sha256: distroSha256, user_sha256: userSha256, uid: 1000 },
        scenarios: { "9": true, "10": true },
        completed_at: completedAt,
      },
    })
  })

  test("rejects foreign authority, non-diagnostic harness results, missing phases, and identity substitution", async () => {
    for (const hostile of [
      dependencies({ env: { ...env, GITHUB_RUN_ATTEMPT: "01" } }),
      dependencies({
        env: { ...env, GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace("preliminary-unsigned", "next-beta") },
      }),
      dependencies({ runHarness: async () => ({ authority: "PASS" }) }),
      dependencies({
        runHarness: async (_input: string[], options: { runCase: (value: { case: CaseName }) => unknown }) => {
          await options.runCase({ case: "scenario-9" })
          return { authority: "DIAGNOSTIC" }
        },
      }),
      dependencies({
        executeCase: async ({ case: name }: { case: CaseName }) => ({
          ...observation(name),
          user_sha256: name === "scenario-10-after-restart" ? "0".repeat(64) : userSha256,
        }),
      }),
    ]) {
      await expect(runPreliminaryWindowsAcceptance(argv, hostile)).rejects.toThrow()
    }
  })
})
