import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { validatePreliminaryUnsignedWslReceipt } from "../../opencode/script/lean-preliminary-unsigned-wsl.mjs"
import {
  parsePreliminaryPackagedCaseOutput,
  runPreliminaryWindowsAcceptance,
} from "./wsl-windows-preliminary-acceptance.mjs"

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
  GITHUB_REF: "refs/heads/codex/windows-startup-hotfix-1.15.22",
  GITHUB_SHA: sourceSha,
  GITHUB_WORKFLOW_REF:
    "BharatCode-ai/bharatcode-desktop/.github/workflows/bharatcode-preliminary-unsigned-wsl.yml@refs/heads/codex/windows-startup-hotfix-1.15.22",
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
  test("accepts only the exact Electron Windows CRLF prelude around one canonical record", () => {
    const record = observation("scenario-9")
    const line = JSON.stringify(record)
    expect(parsePreliminaryPackagedCaseOutput(`${line}\n`, "")).toEqual(record)
    expect(parsePreliminaryPackagedCaseOutput(`\r\n${line}\n`, "")).toEqual(record)
    for (const output of [`\n${line}\n`, `\r\n\r\n${line}\n`, ` ${line}\n`, `\r\n${line}\n\n`]) {
      expect(() => parsePreliminaryPackagedCaseOutput(output, "")).toThrow()
    }
    expect(() => parsePreliminaryPackagedCaseOutput(`\r\n${line}\n`, "foreign stderr")).toThrow()
    expect(() => parsePreliminaryPackagedCaseOutput(`\r\n${"x".repeat(16_385)}\n`, "")).toThrow()
  })

  test("projects only observations accepted by the unchanged diagnostic harness", async () => {
    const result = await runPreliminaryWindowsAcceptance(argv, dependencies())
    expect(result).toEqual({
      authority: "PRELIMINARY_UNSIGNED",
      harness_authority: "DIAGNOSTIC",
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
    const bindings = {
      adapter_sha256: "a".repeat(64),
      evidence_script_sha256: "b".repeat(64),
      source_sha: sourceSha,
      run_id: env.GITHUB_RUN_ID,
      run_attempt: env.GITHUB_RUN_ATTEMPT,
      unsigned_installer_bytes: 4096,
      unsigned_installer_sha256: "d".repeat(64),
      installed_desktop_bytes: 8192,
      installed_desktop_sha256: desktopSha256,
      runtime_manifest_sha256: manifestSha256,
      runtime_sha256: runtimeSha256,
      harness_sha256: "e".repeat(64),
      validator_sha256: "c".repeat(64),
    }
    const receipt = {
      schema: "bharatcode-wsl-preliminary-unsigned-v1",
      evidence_class: result.authority,
      result: result.authority,
      signature_status: result.authority,
      provenance_status: result.authority,
      cleanup_complete: true,
      promotable: false,
      composable: false,
      controller_inputs: {
        adapter_sha256: bindings.adapter_sha256,
        evidence_script_sha256: bindings.evidence_script_sha256,
        validator_sha256: bindings.validator_sha256,
      },
      repository: env.GITHUB_REPOSITORY,
      workflow: ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
      source_sha: result.evidence.source_sha,
      github: { run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) },
      unsigned_installer: {
        filename: "bharatcode-desktop-preliminary-unsigned-test-win-x64.exe",
        bytes: bindings.unsigned_installer_bytes,
        sha256: bindings.unsigned_installer_sha256,
      },
      installed_desktop: {
        filename: "BharatCode Beta.exe",
        bytes: bindings.installed_desktop_bytes,
        sha256: result.evidence.desktop_sha256,
      },
      runtime_manifest_sha256: result.evidence.runtime_manifest_sha256,
      runtime: result.evidence.runtime,
      harness: {
        contract: "packages/desktop/scripts/wsl-windows-acceptance.mjs",
        contract_sha256: bindings.harness_sha256,
        authority: result.harness_authority,
      },
      identity: result.evidence.identity,
      scenarios: result.evidence.scenarios,
      completed_at: result.evidence.completed_at,
    }
    expect(validatePreliminaryUnsignedWslReceipt(receipt, bindings)).toEqual(receipt)
  })

  test("rejects foreign authority, non-diagnostic harness results, missing phases, and identity substitution", async () => {
    for (const hostile of [
      dependencies({ env: { ...env, GITHUB_RUN_ATTEMPT: "01" } }),
      dependencies({
        env: {
          ...env,
          GITHUB_REF: "refs/heads/dev",
          GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace("codex/windows-startup-hotfix-1.15.22", "dev"),
        },
      }),
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
