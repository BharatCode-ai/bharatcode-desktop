import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
  canonicalLeanJson,
  parseCurrentBetaFixtureBytes,
  parseLeanUpgradeReceiptBytes,
  validateLeanUpgradeReceipt,
} from "./lean-upgrade-receipt.mjs"

const fixturePath = resolve(import.meta.dir, "../test/fixtures/current-beta-windows-x64.json")
const sourceSha = "3b09dcff0d7e8ad7487c6d40199b704ed0712005"
const bindings = { source_sha: sourceSha, run_id: "123456789", run_attempt: "1" }
const candidate = {
  key: "desktop-windows-x64",
  filename: "bharatcode-desktop-next-beta-win-x64.exe",
  bytes: 120_000_000,
  sha256: "a".repeat(64),
}

async function fixture() {
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

async function receipt() {
  const currentBeta = await fixture()
  return {
    schema: "bharatcode-lean-upgrade-rollback-receipt-v1",
    result: "PASS",
    repository: "BharatCode-ai/bharatcode-desktop",
    source_sha: sourceSha,
    candidate_tag: `next-beta-${sourceSha.slice(0, 12)}`,
    github: { run_id: bindings.run_id, run_attempt: bindings.run_attempt },
    host: { os: "windows", arch: "x64", runner_image: "windows-2025" },
    current_beta: {
      release_id: currentBeta.release_id,
      tag: currentBeta.tag,
      source_sha: currentBeta.source_sha,
      asset: currentBeta.assets[0],
    },
    candidate: { ...candidate },
    checks: checks(),
    completed_at: "2026-07-20T10:00:00.000Z",
  }
}

describe("lean packaged upgrade/rollback receipt contract", () => {
  test("pins the closed public current-beta release and selected Windows asset", async () => {
    const value = await fixture()
    expect(value).toEqual({
      schema: "bharatcode-current-beta-fixture-v1",
      repository: "BharatCode-ai/bharatcode-desktop",
      release_id: "351974071",
      tag: "desktop-beta-2026-07-10-account-auth-001",
      source_sha: "01737c1cb123909c2ca0626d3fc2ce475fe7c599",
      assets: [
        {
          key: "desktop-windows-x64",
          asset_id: "472279670",
          filename: "bharatcode-desktop-win-x64.exe",
          bytes: 119910146,
          sha256: "cb7d4252441da3704d915c3a3afa908ea04efa6e6cd5552fe683aef65e9982e1",
        },
      ],
    })
    expect(JSON.stringify(value)).not.toMatch(/browser_download_url|api.github.com|latest/i)
  })

  test("accepts one complete secret-free Windows x64 PASS receipt", async () => {
    const value = await receipt()
    const currentBeta = await fixture()
    expect(validateLeanUpgradeReceipt(value, { ...bindings, current_beta: currentBeta, candidate })).toEqual(value)
    expect(
      parseLeanUpgradeReceiptBytes(Buffer.from(canonicalLeanJson(value)), {
        ...bindings,
        current_beta: currentBeta,
        candidate,
      }),
    ).toEqual(value)
    expect(JSON.stringify(value)).not.toMatch(/token|password|secret|cookie|authorization|user_data_path/i)
  })

  test("rejects missing, extra, duplicate raw, and mutable URL fields", async () => {
    const currentBeta = await fixture()
    const missing = (await receipt()) as Record<string, unknown>
    const extra = await receipt()
    delete missing.host
    expect(() => validateLeanUpgradeReceipt(missing, { ...bindings, current_beta: currentBeta, candidate })).toThrow()
    expect(() =>
      validateLeanUpgradeReceipt(
        { ...extra, browser_download_url: "https://github.com/latest" },
        { ...bindings, current_beta: currentBeta, candidate },
      ),
    ).toThrow()
    expect(() =>
      parseLeanUpgradeReceiptBytes(
        Buffer.from(
          '{"schema":"bharatcode-lean-upgrade-rollback-receipt-v1","schema":"bharatcode-lean-upgrade-rollback-receipt-v1"}',
        ),
        { ...bindings, current_beta: currentBeta, candidate },
      ),
    ).toThrow(/canonical|duplicate|keys/i)
  })

  test("rejects wrong source, run, attempt, candidate tag, host, or candidate artifact", async () => {
    const currentBeta = await fixture()
    for (const value of [
      { ...(await receipt()), source_sha: "0".repeat(40) },
      { ...(await receipt()), github: { run_id: "123456788", run_attempt: "1" } },
      { ...(await receipt()), github: { run_id: "123456789", run_attempt: "2" } },
      { ...(await receipt()), candidate_tag: "next-beta-latest" },
      { ...(await receipt()), host: { os: "linux", arch: "x64", runner_image: "ubuntu-24.04" } },
      { ...(await receipt()), candidate: { ...(await receipt()).candidate, key: "desktop-linux-x64-deb" } },
    ]) {
      expect(() => validateLeanUpgradeReceipt(value, { ...bindings, current_beta: currentBeta, candidate })).toThrow()
    }
  })

  test("rejects a well-formed alternate candidate artifact identity", async () => {
    const currentBeta = await fixture()
    const value = await receipt()
    value.candidate = {
      key: "desktop-windows-x64",
      filename: "bharatcode-desktop-substituted-win-x64.exe",
      bytes: 1,
      sha256: "b".repeat(64),
    }
    expect(() => validateLeanUpgradeReceipt(value, { ...bindings, current_beta: currentBeta, candidate })).toThrow(
      /candidate.*(?:match|identity)/i,
    )
    const original = await receipt()
    expect(() =>
      validateLeanUpgradeReceipt(original, {
        ...bindings,
        current_beta: currentBeta,
        candidate: { ...candidate, url: "https://example.invalid/latest" },
      }),
    ).toThrow(/candidate.*keys/i)
  })

  test("rejects changed current-beta asset identity and incomplete host checks", async () => {
    const currentBeta = await fixture()
    const changedReceipt = await receipt()
    changedReceipt.current_beta.asset = { ...changedReceipt.current_beta.asset, bytes: 119910145 }
    expect(() =>
      validateLeanUpgradeReceipt(changedReceipt, { ...bindings, current_beta: currentBeta, candidate }),
    ).toThrow(/beta|asset|bytes|identity/i)

    const incomplete = await receipt()
    const incompleteChecks = incomplete.checks as Record<string, boolean>
    delete incompleteChecks.rollback_installed
    expect(() => validateLeanUpgradeReceipt(incomplete, { ...bindings, current_beta: currentBeta, candidate })).toThrow(
      /check|keys|complete/i,
    )
  })

  test("rejects ShareNext-enabled or network-attempting acceptance", async () => {
    const currentBeta = await fixture()
    for (const checksOverride of [{ sharenext_absent: false }, { share_network_attempt_absent: false }]) {
      const value = await receipt()
      value.checks = { ...value.checks, ...checksOverride }
      expect(() => validateLeanUpgradeReceipt(value, { ...bindings, current_beta: currentBeta, candidate })).toThrow(
        /ShareNext|network|check/i,
      )
    }
  })
})
