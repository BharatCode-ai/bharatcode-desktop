import { execFile } from "node:child_process"
import { promisify } from "node:util"

import {
  acceptanceChildEnvironment,
  parseAcceptanceArguments,
  parseAcceptanceObservation,
  runWindowsAcceptance,
} from "./wsl-windows-acceptance.mjs"

const execFileAsync = promisify(execFile)
const phases = ["scenario-9", "scenario-10-before-restart", "scenario-10-after-restart"]

export async function runPreliminaryWindowsAcceptance(argv, dependencies = {}) {
  const input = parseAcceptanceArguments(argv)
  const env = dependencies.env ?? process.env
  preliminaryAuthority(env, input.sourceSha)
  const observations = []
  const executeCase = dependencies.executeCase ?? runExecutableCase
  const result = await (dependencies.runHarness ?? runWindowsAcceptance)(argv, {
    ...(dependencies.harness ?? {}),
    env: { ...env, GITHUB_ACTIONS: "false" },
    runCase: async (value) => {
      const observation = parseAcceptanceObservation(await executeCase(value))
      observations.push(observation)
      return observation
    },
  })
  if (result.authority !== "DIAGNOSTIC" || result.receiptPath !== undefined || result.digestPath !== undefined) {
    throw new Error("Preliminary WSL requires the unchanged diagnostic harness boundary")
  }
  if (
    observations.length !== phases.length ||
    observations.some((observation, index) => observation.case !== phases[index])
  ) {
    throw new Error("Preliminary WSL harness phase chain is incomplete or reordered")
  }
  const scenario9 = observations[0]
  for (const observation of observations) {
    if (!sameIdentity(scenario9, observation) || observation.source_sha !== input.sourceSha) {
      throw new Error("Preliminary WSL observation identity mismatch")
    }
  }
  return {
    authority: "PRELIMINARY_UNSIGNED",
    harness_authority: "DIAGNOSTIC",
    evidence: {
      source_sha: input.sourceSha,
      desktop_sha256: scenario9.desktop_sha256,
      runtime_manifest_sha256: scenario9.runtime_manifest_sha256,
      runtime: {
        manifest_source_sha: scenario9.manifest_source_sha,
        executed_source_sha: scenario9.executed_source_sha,
        manifest_sha256: scenario9.manifest_runtime_sha256,
        executed_sha256: scenario9.executed_runtime_sha256,
      },
      identity: {
        distro_sha256: scenario9.distro_sha256,
        user_sha256: scenario9.user_sha256,
        uid: scenario9.uid,
      },
      scenarios: { 9: true, 10: true },
      completed_at: (dependencies.now ?? (() => new Date()))().toISOString(),
    },
  }
}

async function runExecutableCase(input) {
  const result = await execFileAsync(
    input.desktopExe,
    [
      "--bharatcode-wsl-acceptance-case",
      input.case,
      "--runtime-manifest",
      input.runtimeManifest,
      "--distribution",
      input.distribution,
      "--invalid-distribution",
      input.invalidDistribution,
      "--missing-prerequisite-distribution",
      input.missingPrerequisiteDistribution,
      "--windows-project",
      input.windowsProject,
      "--source-sha",
      input.sourceSha,
      "--acceptance-dir",
      input.acceptanceDirectory,
    ],
    {
      windowsHide: true,
      shell: false,
      timeout: 300_000,
      maxBuffer: 16_384,
      encoding: "utf8",
      env: acceptanceChildEnvironment(process.env),
    },
  )
  return parsePreliminaryPackagedCaseOutput(result.stdout, result.stderr)
}

export function parsePreliminaryPackagedCaseOutput(stdout, stderr) {
  if (stderr) throw new Error("Preliminary packaged acceptance case wrote stderr")
  const output = stdout.startsWith("\r\n") ? stdout.slice(2) : stdout
  const line = output.endsWith("\n") ? output.slice(0, -1) : output
  if (!line || /\r|\n/u.test(line) || Buffer.byteLength(line) > 8_192) {
    throw new Error("Preliminary packaged acceptance case output is not one bounded JSON record")
  }
  const value = JSON.parse(line)
  if (line !== JSON.stringify(value))
    throw new Error("Preliminary packaged acceptance case output must be canonical JSON")
  return value
}

function preliminaryAuthority(env, sourceSha) {
  const repository = "BharatCode-ai/bharatcode-desktop"
  const workflow = `${repository}/.github/workflows/bharatcode-preliminary-unsigned-wsl.yml@refs/heads/codex/windows-startup-hotfix-1.15.22`
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "Windows" ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_REF !== "refs/heads/codex/windows-startup-hotfix-1.15.22" ||
    env.GITHUB_WORKFLOW_REF !== workflow ||
    env.GITHUB_SHA !== sourceSha
  ) {
    throw new Error("Preliminary WSL authority is unavailable")
  }
  for (const value of [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT]) {
    if (!/^[1-9][0-9]*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
      throw new Error("Preliminary WSL run identity is invalid")
    }
  }
}

function sameIdentity(left, right) {
  return [
    "source_sha",
    "desktop_sha256",
    "runtime_manifest_sha256",
    "manifest_source_sha",
    "executed_source_sha",
    "manifest_runtime_sha256",
    "executed_runtime_sha256",
    "distro_sha256",
    "user_sha256",
    "uid",
    "wsl_version",
  ].every((key) => left[key] === right[key])
}
