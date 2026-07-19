import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import {
  parseUpgradeAcceptanceArguments,
  runLeanUpgradeAcceptance,
  validateCurrentBetaApiObservation,
  validateUpgradeExecutionObservation,
  verifyPinnedInstaller,
} from "./lean-upgrade-acceptance.mjs"
import { canonicalLeanJson, parseCurrentBetaFixtureBytes } from "./lean-upgrade-receipt.mjs"

const sourceSha = "3b09dcff0d7e8ad7487c6d40199b704ed0712005"
const fixturePath = resolve(import.meta.dir, "../test/fixtures/current-beta-windows-x64.json")
const candidate = {
  key: "desktop-windows-x64",
  filename: "bharatcode-desktop-next-beta-win-x64.exe",
  bytes: 120_000_000,
  sha256: "a".repeat(64),
}

async function currentBeta() {
  return parseCurrentBetaFixtureBytes(new Uint8Array(await Bun.file(fixturePath).arrayBuffer()))
}

function checks() {
  return {
    current_beta_download_verified: true,
    current_beta_installed_and_started: true,
    eligible_state_seeded: true,
    candidate_installed_over_beta: true,
    eligible_state_preserved: true,
    candidate_started: true,
    bharatcode_runtime_only: true,
    rollback_installed: true,
    rollback_state_structurally_valid: true,
    migration_source_preserved: true,
    recovery_evidence_preserved: true,
    sharenext_absent: true,
    share_network_attempt_absent: true,
  }
}

function observation() {
  return {
    schema: "bharatcode-packaged-upgrade-observation-v1",
    candidate: { ...candidate },
    checks: checks(),
    cleanup_complete: true,
  }
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lean-upgrade-acceptance-"))
  const acceptanceDirectory = join(root, "acceptance")
  const localFixture = join(root, "current-beta.json")
  const candidatePath = join(root, candidate.filename)
  await writeFile(localFixture, canonicalLeanJson(await currentBeta()))
  await writeFile(candidatePath, "candidate")
  const argv = [
    "--fixture",
    localFixture,
    "--candidate",
    candidatePath,
    "--source-sha",
    sourceSha,
    "--acceptance-dir",
    acceptanceDirectory,
  ]
  const dependencies = {
    platform: "win32",
    arch: "x64",
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "123456789",
      GITHUB_RUN_ATTEMPT: "2",
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      RUNNER_ENVIRONMENT: "github-hosted",
      ImageOS: "win25",
      ImageVersion: "20260713.1.0",
    },
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    execute: async () => observation(),
    ...overrides,
  }
  return { root, acceptanceDirectory, localFixture, candidatePath, argv, dependencies }
}

describe("real packaged Windows upgrade and rollback acceptance", () => {
  test("accepts only the exact closed CLI and immutable candidate filename", async () => {
    const input = await fixture()
    try {
      expect(parseUpgradeAcceptanceArguments(input.argv)).toEqual({
        fixture: input.localFixture,
        candidate: input.candidatePath,
        sourceSha,
        acceptanceDirectory: input.acceptanceDirectory,
      })
      for (const hostile of [
        input.argv.slice(0, -2),
        [...input.argv, "--extra", "value"],
        input.argv.map((value) => (value === sourceSha ? "0".repeat(40) : value)),
        input.argv.map((value) => (value === input.candidatePath ? join(input.root, "candidate.exe") : value)),
      ]) {
        expect(() => parseUpgradeAcceptanceArguments(hostile)).toThrow()
      }
    } finally {
      await rm(input.root, { recursive: true, force: true })
    }
  })

  test("closes the public release, tag source, and selected asset API identity", async () => {
    const beta = await currentBeta()
    const asset = beta.assets[0]
    const value = {
      release: {
        id: Number(beta.release_id),
        tag_name: beta.tag,
        url: `https://api.github.com/repos/${beta.repository}/releases/${beta.release_id}`,
        assets_url: `https://api.github.com/repos/${beta.repository}/releases/${beta.release_id}/assets`,
        assets: [
          {
            id: Number(asset.asset_id),
            name: asset.filename,
            size: asset.bytes,
            digest: `sha256:${asset.sha256}`,
            url: `https://api.github.com/repos/${beta.repository}/releases/assets/${asset.asset_id}`,
          },
        ],
      },
      tag_commit_sha: beta.source_sha,
      asset: {
        id: Number(asset.asset_id),
        name: asset.filename,
        size: asset.bytes,
        digest: `sha256:${asset.sha256}`,
        url: `https://api.github.com/repos/${beta.repository}/releases/assets/${asset.asset_id}`,
      },
    }
    expect(validateCurrentBetaApiObservation(value, beta)).toEqual(value)
    for (const hostile of [
      { ...value, tag_commit_sha: "0".repeat(40) },
      { ...value, release: { ...value.release, id: 1 } },
      { ...value, release: { ...value.release, assets: [...value.release.assets, value.release.assets[0]] } },
      { ...value, asset: { ...value.asset, id: 1 } },
      { ...value, asset: { ...value.asset, size: asset.bytes - 1 } },
      { ...value, asset: { ...value.asset, digest: `sha256:${"b".repeat(64)}` } },
    ]) {
      expect(() => validateCurrentBetaApiObservation(hostile, beta)).toThrow()
    }
  })

  test("rejects a candidate installer substituted after its pinned observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lean-upgrade-installer-"))
    const path = join(root, candidate.filename)
    const bytes = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(16), Buffer.from("PE\0\0"), Buffer.alloc(16)])
    const expected = {
      ...candidate,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
    try {
      await writeFile(path, bytes)
      expect(await verifyPinnedInstaller(path, expected)).toEqual(expected)
      await writeFile(path, Buffer.concat([bytes, Buffer.from("substituted")]))
      await expect(verifyPinnedInstaller(path, expected)).rejects.toThrow(/byte|SHA|changed|identity/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects incomplete checks, ShareNext/network attempts, cleanup drift, and secret leakage", () => {
    expect(validateUpgradeExecutionObservation(observation())).toEqual(observation())
    const missing = observation() as { checks: Record<string, boolean> }
    delete missing.checks.rollback_installed
    for (const hostile of [
      missing,
      { ...observation(), checks: { ...checks(), candidate_started: false } },
      { ...observation(), checks: { ...checks(), sharenext_absent: false } },
      { ...observation(), checks: { ...checks(), share_network_attempt_absent: false } },
      { ...observation(), cleanup_complete: false },
      { ...observation(), bearer_token: "secret-value" },
    ]) {
      expect(() => validateUpgradeExecutionObservation(hostile)).toThrow()
    }
  })

  test("fails before effects for fixture substitution and pre-existing acceptance output", async () => {
    const substituted = await fixture()
    try {
      const changed = await currentBeta()
      changed.assets[0].bytes -= 1
      await writeFile(substituted.localFixture, canonicalLeanJson(changed))
      let effects = 0
      await expect(
        runLeanUpgradeAcceptance(substituted.argv, {
          ...substituted.dependencies,
          execute: async () => {
            effects += 1
            return observation()
          },
        }),
      ).rejects.toThrow(/beta|asset|identity/i)
      expect(effects).toBe(0)
    } finally {
      await rm(substituted.root, { recursive: true, force: true })
    }

    const preexisting = await fixture()
    try {
      await mkdir(preexisting.acceptanceDirectory)
      await writeFile(join(preexisting.acceptanceDirectory, "upgrade-rollback-windows-x64.json"), "hostile")
      await expect(runLeanUpgradeAcceptance(preexisting.argv, preexisting.dependencies)).rejects.toThrow(
        /create-only|already exists/i,
      )
    } finally {
      await rm(preexisting.root, { recursive: true, force: true })
    }
  })

  test("rejects non-Windows, non-x64, process timeout/failure, and rollback failure without a receipt", async () => {
    for (const hostile of [
      { platform: "linux" },
      { arch: "arm64" },
      { execute: async () => Promise.reject(new Error("candidate startup timed out")) },
      { execute: async () => Promise.reject(new Error("installer process failed")) },
      { execute: async () => Promise.reject(new Error("rollback failed")) },
    ]) {
      const input = await fixture(hostile)
      try {
        await expect(runLeanUpgradeAcceptance(input.argv, input.dependencies)).rejects.toThrow()
        expect(await Bun.file(join(input.acceptanceDirectory, "upgrade-rollback-windows-x64.json")).exists()).toBe(
          false,
        )
      } finally {
        await rm(input.root, { recursive: true, force: true })
      }
    }
  })

  test("keeps a complete synthetic adapter diagnostic and structurally unable to emit PASS", async () => {
    const input = await fixture()
    try {
      const result = await runLeanUpgradeAcceptance(input.argv, input.dependencies)
      expect(result).toEqual({ authority: "DIAGNOSTIC", receiptPath: undefined })
      expect(await Bun.file(join(input.acceptanceDirectory, "upgrade-rollback-windows-x64.json")).exists()).toBe(false)
    } finally {
      await rm(input.root, { recursive: true, force: true })
    }
  })

  test("ships explicit real installer, process, timeout, cleanup, state, recovery, and network boundaries", async () => {
    const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
    for (const required of [
      "RUNNER_ENVIRONMENT",
      "fetch(",
      'open(path, "wx"',
      "Bun.spawn(",
      '"/S"',
      '"taskkill"',
      "PROCESS_TIMEOUT_MS",
      "bharatcode-beta.exe",
      "recovery",
      "status",
      "start-fresh",
      "--confirm",
      "--json",
      '"models", "opencode"',
      "BharatCode ships only the BharatCode provider",
      "candidate did not replace the beta installation",
      "rollback did not restore the exact beta installation",
      "directoryIdentity",
      "Acceptance process timed out",
      "log-net-log",
      "betaStart.netLog",
      "candidateStart.netLog",
      "rollbackStart.netLog",
      "migration-source.json",
      "recovery-evidence.json",
      "initializeIsolatedProfile",
      "parseLeanUpgradeReceiptBytes",
    ]) {
      expect(source).toContain(required)
    }
    expect(source).not.toMatch(/extract|mock.*PASS|force.*PASS/iu)
    const betaStart = source.indexOf('startDesktop(installDirectory, profile, "current-beta"')
    const candidateInstall = source.indexOf("runInstaller(input.candidate")
    const recovery = source.indexOf("initializeRecoveryState(installDirectory, profile)")
    const candidateStart = source.indexOf('startDesktop(installDirectory, profile, "candidate"')
    expect(betaStart).toBeGreaterThan(-1)
    expect(candidateInstall).toBeGreaterThan(betaStart)
    expect(recovery).toBeGreaterThan(candidateInstall)
    expect(candidateStart).toBeGreaterThan(recovery)
    expect(basename(fixturePath)).toBe("current-beta-windows-x64.json")
  })
})
