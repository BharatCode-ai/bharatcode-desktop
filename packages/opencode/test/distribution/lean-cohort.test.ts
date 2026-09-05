import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
  REQUIRED_COHORT_KEYS,
  canonicalLeanJson,
  parseLeanCohortBytes,
  validateLeanCohort,
  validateLeanUpgradeWaiver,
  validateLeanUpdaterInfo,
  validateLeanWslWaiver,
} from "../../script/lean-cohort.mjs"

const sourceSha = "3b09dcff0d7e8ad7487c6d40199b704ed0712005"
const bindings = { source_sha: sourceSha, run_id: "123456789", run_attempt: "1" }
const completedAt = "2026-07-20T10:00:00.000Z"
const adapterPath = resolve(import.meta.dir, "../../script/preliminary-jit-evidence-cli.mjs")

function signing(key: string, wslGateResult = "PASS", upgradeGateResult = "PASS") {
  if (key === "desktop-windows-x64") return "unsigned"
  if (key.includes("blockmap") || key.includes("update-info")) return "not-applicable"
  if (key.startsWith("desktop-macos-")) return "apple-notarized-stapled"
  if (key === "wsl-gate") return wslGateResult === "PASS" ? "acceptance-receipt" : "owner-waiver-receipt"
  if (key === "upgrade-rollback-windows-x64")
    return upgradeGateResult === "PASS" ? "acceptance-receipt" : "owner-waiver-receipt"
  if (key.endsWith("receipt")) return "acceptance-receipt"
  return "not-applicable"
}

function platform(key: string) {
  if (key.includes("windows") || key === "upgrade-rollback-windows-x64") return "windows"
  if (key.includes("darwin") || key.includes("macos")) return "macos"
  if (key.includes("linux")) return "linux"
  if (key === "wsl-gate") return "windows-wsl2"
  return "npm"
}

function arch(key: string) {
  if (key === "cli-bharatcode") return "universal"
  if (key === "desktop-macos-update-info") return "universal"
  if (key.includes("arm64")) return "arm64"
  return "x64"
}

function artifact(key: string, index: number, wslGateResult = "PASS", upgradeGateResult = "PASS") {
  const sha256 = index.toString(16).padStart(64, "0")
  const attestationSha256 = (index + 100).toString(16).padStart(64, "0")
  return {
    key,
    platform: platform(key),
    arch: arch(key),
    filename: key.startsWith("cli-")
      ? `${key}-1.15.26.tgz`
      : ({
          "desktop-linux-x64-update-info": "beta-linux.yml",
          "desktop-macos-arm64-blockmap": "bharatcode-desktop-next-beta-mac-arm64.zip.blockmap",
          "desktop-macos-update-info": "beta-mac.yml",
          "desktop-macos-x64-blockmap": "bharatcode-desktop-next-beta-mac-x64.zip.blockmap",
          "desktop-windows-update-info": "beta.yml",
          "desktop-windows-x64-blockmap": "bharatcode-desktop-next-beta-win-x64.exe.blockmap",
        }[key] ?? `${key}.json`),
    bytes: 1_000 + index,
    sha256,
    artifact_attestation: {
      filename: `${key}.intoto.jsonl`,
      bytes: 2_000 + index,
      sha256: attestationSha256,
      subject_sha256: sha256,
      predicate_type: "https://slsa.dev/provenance/v1",
    },
    signing: signing(key, wslGateResult, upgradeGateResult),
    completed_at: "2026-07-20T09:59:00.000Z",
  }
}

function manifest(wslGateResult = "PASS", upgradeGateResult = "PASS") {
  const artifacts = REQUIRED_COHORT_KEYS.map((key, index) => artifact(key, index, wslGateResult, upgradeGateResult))
  const wslGate = artifacts.find((item) => item.key === "wsl-gate")!
  wslGate.filename =
    wslGateResult === "PASS" ? "bharatcode-wsl-scenarios-9-10.json" : "bharatcode-wsl-acceptance-waiver.json"
  wslGate.artifact_attestation.filename = `${wslGate.filename}.intoto.jsonl`
  const upgradeGate = artifacts.find((item) => item.key === "upgrade-rollback-windows-x64")!
  upgradeGate.filename =
    upgradeGateResult === "PASS"
      ? "bharatcode-upgrade-rollback-windows-x64.json"
      : "bharatcode-upgrade-rollback-waiver-windows-x64.json"
  upgradeGate.artifact_attestation.filename = `${upgradeGate.filename}.intoto.jsonl`
  return {
    schema: "bharatcode-next-beta-cohort-v3",
    repository: "BharatCode-ai/bharatcode-desktop",
    source_sha: sourceSha,
    candidate_tag: "desktop-beta-1.15.26",
    desktop_version: "1.15.26",
    cli_version: "1.15.26",
    wsl_runtime_version: "1.15.26",
    channel: "beta",
    workflow: ".github/workflows/bharatcode-next-beta-candidate.yml",
    run_id: bindings.run_id,
    run_attempt: bindings.run_attempt,
    upgrade_gate_result: upgradeGateResult,
    upgrade_receipt_sha256: upgradeGate.sha256,
    wsl_gate_result: wslGateResult,
    wsl_receipt_sha256: wslGate.sha256,
    artifacts,
    completed_at: completedAt,
  }
}

describe("lean next-beta cohort contract", () => {
  test("accepts one exact source/run/attempt cohort with the complete sorted key set", () => {
    const value = manifest()
    expect(validateLeanCohort(value, bindings)).toEqual(value)
    expect(value.artifacts.map((item) => item.key)).toEqual([...REQUIRED_COHORT_KEYS])
    expect(parseLeanCohortBytes(Buffer.from(canonicalLeanJson(value)), bindings)).toEqual(value)
  })

  test("accepts an explicit owner waiver without claiming automated WSL acceptance", () => {
    const value = manifest("OWNER_WAIVED")
    expect(validateLeanCohort(value, bindings)).toEqual(value)
    const gate = value.artifacts.find((item) => item.key === "wsl-gate")!
    expect(gate.signing).toBe("owner-waiver-receipt")
    expect(gate.filename).toBe("bharatcode-wsl-acceptance-waiver.json")
  })

  test("accepts an explicit upgrade waiver without claiming upgrade acceptance", () => {
    const value = manifest("OWNER_WAIVED", "OWNER_WAIVED")
    expect(validateLeanCohort(value, bindings)).toEqual(value)
    const gate = value.artifacts.find((item) => item.key === "upgrade-rollback-windows-x64")!
    expect(gate.signing).toBe("owner-waiver-receipt")
    expect(gate.filename).toBe("bharatcode-upgrade-rollback-waiver-windows-x64.json")
  })

  test("validates the policy-bound cohort through the host-controller stdin adapter", async () => {
    const value = manifest()
    const canonical = canonicalLeanJson(value)
    const child = Bun.spawn([process.execPath, adapterPath, "cohort"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(JSON.stringify({ raw: canonical, identity: bindings }))
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(await new Response(child.stdout).text()).toBe(canonical)

    const duplicate = Bun.spawn([process.execPath, adapterPath, "cohort"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    duplicate.stdin.write(
      JSON.stringify({
        raw: canonical.replace(
          '"schema":"bharatcode-next-beta-cohort-v3"',
          '"schema":"bharatcode-next-beta-cohort-v3","schema":"bharatcode-next-beta-cohort-v3"',
        ),
        identity: bindings,
      }),
    )
    duplicate.stdin.end()
    expect(await duplicate.exited).toBe(1)
  })

  test("rejects missing, extra, and duplicate raw keys", () => {
    const missing = manifest() as Record<string, unknown>
    delete missing.channel
    expect(() => validateLeanCohort(missing, bindings)).toThrow(/keys|channel/i)
    expect(() => validateLeanCohort({ ...manifest(), url: "https://example.invalid/latest" }, bindings)).toThrow(
      /keys|url/i,
    )
    expect(() =>
      parseLeanCohortBytes(
        Buffer.from('{"schema":"bharatcode-next-beta-cohort-v3","schema":"bharatcode-next-beta-cohort-v3"}'),
        bindings,
      ),
    ).toThrow(/canonical|duplicate|keys/i)
  })

  test("rejects wrong source, run, attempt, or release tag", () => {
    for (const value of [
      { ...manifest(), source_sha: "0".repeat(40) },
      { ...manifest(), run_id: "123456788" },
      { ...manifest(), run_attempt: "2" },
      { ...manifest(), candidate_tag: "desktop-beta-latest" },
    ]) {
      expect(() => validateLeanCohort(value, bindings)).toThrow(/source|run|attempt|tag/i)
    }
  })

  test("rejects mutable URLs and duplicate artifact keys, filenames, or attestation bundles", () => {
    const cases = [
      () => {
        const value = manifest()
        value.artifacts[0].filename = "https://example.invalid/latest"
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[1].key = value.artifacts[0].key
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[1].filename = value.artifacts[0].filename
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[1].artifact_attestation.filename = value.artifacts[0].artifact_attestation.filename
        return value
      },
    ]
    for (const hostile of cases) expect(() => validateLeanCohort(hostile(), bindings)).toThrow()
  })

  test("rejects wrong size, digest, attestation subject, or signing-policy drift", () => {
    const cases = [
      () => {
        const value = manifest()
        value.artifacts[0].bytes = 0
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[0].sha256 = "A".repeat(64)
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[0].artifact_attestation.sha256 = "A".repeat(64)
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[0].artifact_attestation.subject_sha256 = "f".repeat(64)
        return value
      },
      () => {
        const value = manifest()
        value.artifacts.find((item) => item.key === "desktop-windows-x64")!.signing = "authenticode"
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[1].signing = "unsigned"
        return value
      },
    ]
    for (const hostile of cases) expect(() => validateLeanCohort(hostile(), bindings)).toThrow()
  })

  test("normalizes exact electron-builder updater metadata to immutable public package names", () => {
    const sha512 = Buffer.alloc(64, 97).toString("base64")
    const value = {
      version: "1.15.26",
      files: [{ url: "bharatcode-desktop-windows-x64.exe", sha512, size: 1234 }],
      path: "bharatcode-desktop-windows-x64.exe",
      sha512,
      releaseDate: "2026-09-03T12:00:00.000Z",
    }
    const normalized = validateLeanUpdaterInfo(value, {
      label: "Windows beta updater",
      version: "1.15.26",
      files: [
        {
          source_url: "bharatcode-desktop-windows-x64.exe",
          public_url: "bharatcode-desktop-next-beta-win-x64.exe",
          bytes: 1234,
          sha512,
        },
      ],
    })
    expect(normalized).toEqual({
      ...value,
      files: [{ url: "bharatcode-desktop-next-beta-win-x64.exe", sha512, size: 1234 }],
      path: "bharatcode-desktop-next-beta-win-x64.exe",
    })

    for (const hostile of [
      { ...value, version: "1.15.23" },
      { ...value, path: "https://example.invalid/latest.exe" },
      { ...value, files: [{ ...value.files[0], sha512: Buffer.alloc(64, 98).toString("base64") }] },
      { ...value, extra: true },
    ]) {
      expect(() =>
        validateLeanUpdaterInfo(hostile, {
          label: "Windows beta updater",
          version: "1.15.26",
          files: [
            {
              source_url: "bharatcode-desktop-windows-x64.exe",
              public_url: "bharatcode-desktop-next-beta-win-x64.exe",
              bytes: 1234,
              sha512,
            },
          ],
        }),
      ).toThrow()
    }
  })

  test("requires each expected updater package exactly once and normalizes producer order", () => {
    const appimageSha512 = Buffer.alloc(64, 97).toString("base64")
    const debSha512 = Buffer.alloc(64, 98).toString("base64")
    const updaterBindings = {
      label: "Linux beta updater",
      version: "1.15.26",
      files: [
        {
          source_url: "bharatcode-desktop-linux-x86_64.AppImage",
          public_url: "bharatcode-desktop-next-beta-linux-x64.AppImage",
          bytes: 100,
          sha512: appimageSha512,
        },
        {
          source_url: "bharatcode-desktop-linux-amd64.deb",
          public_url: "bharatcode-desktop-next-beta-linux-x64.deb",
          bytes: 200,
          sha512: debSha512,
        },
      ],
    }
    const appimage = {
      url: updaterBindings.files[0].source_url,
      sha512: appimageSha512,
      size: 100,
      blockMapSize: 25,
    }
    const deb = { url: updaterBindings.files[1].source_url, sha512: debSha512, size: 200 }
    const metadata = (files: Array<typeof appimage | typeof deb>) => ({
      version: "1.15.26",
      files,
      path: files[0].url,
      sha512: files[0].sha512,
      releaseDate: "2026-09-03T12:00:00.000Z",
    })

    const normalized = validateLeanUpdaterInfo(metadata([deb, appimage]), updaterBindings)
    expect(normalized.files.map((file: { url: string }) => file.url)).toEqual(
      updaterBindings.files.map((file) => file.public_url),
    )
    expect(normalized.files[0].blockMapSize).toBe(25)
    expect(() => validateLeanUpdaterInfo(metadata([appimage]), updaterBindings)).toThrow(/incomplete/i)
    expect(() => validateLeanUpdaterInfo(metadata([appimage, appimage]), updaterBindings)).toThrow(/duplicated/i)
  })

  test("preserves the exact electron-builder Linux AppImage block-map contract", async () => {
    const value = Bun.YAML.parse(
      await Bun.file(new URL("./fixtures/beta-linux.producer.yml", import.meta.url)).text(),
    ) as {
      version: string
      files: Array<Record<string, unknown>>
      path: string
      sha512: string
      releaseDate: string
    }
    const updaterBindings = {
      label: "Linux beta updater",
      version: "1.15.26",
      files: [
        {
          source_url: "bharatcode-desktop-linux-x86_64.AppImage",
          public_url: "bharatcode-desktop-next-beta-linux-x64.AppImage",
          bytes: 198867861,
          sha512: "tvYE5dezbYw1wP+ou7vqvZdEbCO4t/sXmJwmefolqB70PVoA+jtM+8r2oO06RgUqck4ZqKuxw6r2MOFLpBK42Q==",
        },
        {
          source_url: "bharatcode-desktop-linux-amd64.deb",
          public_url: "bharatcode-desktop-next-beta-linux-x64.deb",
          bytes: 153157516,
          sha512: "EfxyIxwab2gTxQXOBuhPf2uKDFkQiUfl7z6gfyF43Fqq9w7qXCuYNMAbnpzxcGNsVlxUyWtM6TSLas4HpCcBoQ==",
        },
      ],
    }

    expect(validateLeanUpdaterInfo(value, updaterBindings)).toEqual({
      version: "1.15.26",
      files: [
        {
          url: "bharatcode-desktop-next-beta-linux-x64.AppImage",
          sha512: updaterBindings.files[0].sha512,
          size: 198867861,
          blockMapSize: 207785,
        },
        {
          url: "bharatcode-desktop-next-beta-linux-x64.deb",
          sha512: updaterBindings.files[1].sha512,
          size: 153157516,
        },
      ],
      path: "bharatcode-desktop-next-beta-linux-x64.AppImage",
      sha512: updaterBindings.files[0].sha512,
      releaseDate: "2026-09-03T21:42:49.107Z",
    })

    const appimage = value.files[0]!
    const deb = value.files[1]!
    const withoutBlockMap = { ...appimage }
    delete withoutBlockMap.blockMapSize
    for (const files of [
      [withoutBlockMap, deb],
      [{ ...appimage, unknown: true }, deb],
      [{ ...appimage, blockMapSize: "207785" }, deb],
      [{ ...appimage, blockMapSize: 0 }, deb],
      [{ ...appimage, blockMapSize: 198867861 }, deb],
      [appimage, { ...deb, blockMapSize: 1 }],
    ]) {
      expect(() => validateLeanUpdaterInfo({ ...value, files }, updaterBindings)).toThrow()
    }
  })

  test("rejects incomplete receipt records, wrong WSL binding, version drift, and late artifact completion", () => {
    const cases = [
      () => {
        const value = manifest()
        value.artifacts.pop()
        return value
      },
      () => ({ ...manifest(), wsl_receipt_sha256: "f".repeat(64) }),
      () => ({ ...manifest(), wsl_gate_result: "OWNER_WAIVED" }),
      () => ({ ...manifest(), upgrade_receipt_sha256: "f".repeat(64) }),
      () => ({ ...manifest(), upgrade_gate_result: "OWNER_WAIVED" }),
      () => ({ ...manifest(), wsl_runtime_version: "1.15.20" }),
      () => ({ ...manifest(), cli_version: "1.15.26-01" }),
      () => {
        const value = manifest()
        value.artifacts[0].completed_at = "2026-07-20T10:00:00.001Z"
        return value
      },
    ]
    for (const hostile of cases) expect(() => validateLeanCohort(hostile(), bindings)).toThrow()
  })

  test("accepts only the exact owner-authorized hotfix WSL waiver record", () => {
    const desktopSha256 = "d".repeat(64)
    const runtimeManifestSha256 = "e".repeat(64)
    const receipt = {
      schema: "bharatcode-wsl-acceptance-waiver-v1",
      result: "OWNER_WAIVED",
      reason: "FORMAL_WINDOWS_WSL2_VM_ACCEPTANCE_NOT_RUN_BY_OWNER_DECISION",
      manual_acceptance: "INSTALLED_WINDOWS_STARTUP_SIGNIN_PROJECT_MODELS_SESSION_RESTORE_USER_CONFIRMED",
      accepted_application_source_sha: "80c962f4148db531c35abcf4922059d2101c9bcd",
      source_sha: sourceSha,
      desktop_sha256: desktopSha256,
      runtime_manifest_sha256: runtimeManifestSha256,
      github: { actor: "shrey16", run_id: 123456789, run_attempt: 1 },
      completed_at: completedAt,
    }
    const expected = { ...bindings, desktop_sha256: desktopSha256, runtime_manifest_sha256: runtimeManifestSha256 }
    expect(validateLeanWslWaiver(receipt, expected)).toEqual(receipt)
    for (const hostile of [
      { ...receipt, result: "PASS" },
      { ...receipt, reason: "AUTOMATED_PASS" },
      { ...receipt, accepted_application_source_sha: sourceSha },
      { ...receipt, source_sha: "0".repeat(40) },
      { ...receipt, desktop_sha256: "0".repeat(64) },
      { ...receipt, github: { actor: "shrey16", run_id: 123456788, run_attempt: 1 } },
      { ...receipt, extra: true },
    ]) {
      expect(() => validateLeanWslWaiver(hostile, expected)).toThrow()
    }
    expect(() =>
      validateLeanWslWaiver({ ...receipt, github: { ...receipt.github, actor: "other-owner" } }, expected),
    ).toThrow("dispatcher is not authorized")
  })

  test("accepts only the exact owner-authorized 1.15.27 upgrade waiver record", () => {
    const desktopSha256 = "d".repeat(64)
    const receipt = {
      schema: "bharatcode-windows-upgrade-rollback-waiver-v1",
      result: "OWNER_WAIVED",
      reason: "WINDOWS_UPGRADE_ROLLBACK_ACCEPTANCE_WAIVED_BY_OWNER_FOR_1_15_27",
      obligation: "POST_RELEASE_MANUAL_UPGRADE_ROLLBACK_TEST_REQUIRED",
      accepted_application_source_sha: "80c962f4148db531c35abcf4922059d2101c9bcd",
      source_sha: sourceSha,
      desktop_sha256: desktopSha256,
      failed_evidence: {
        source_sha: "70a1a462dbbfcb2d2fc6485592520ae2342b7e07",
        run_id: 33804419459,
        run_attempt: 1,
        stage: "CANDIDATE_RECOVERY",
      },
      github: { actor: "shrey16", run_id: 123456789, run_attempt: 1 },
      completed_at: completedAt,
    }
    const expected = { ...bindings, desktop_sha256: desktopSha256 }
    expect(validateLeanUpgradeWaiver(receipt, expected)).toEqual(receipt)
    for (const hostile of [
      { ...receipt, result: "PASS" },
      { ...receipt, reason: "AUTOMATED_PASS" },
      { ...receipt, obligation: "NONE" },
      { ...receipt, source_sha: "0".repeat(40) },
      { ...receipt, desktop_sha256: "0".repeat(64) },
      { ...receipt, failed_evidence: { ...receipt.failed_evidence, run_id: 1 } },
      { ...receipt, failed_evidence: { ...receipt.failed_evidence, stage: "PROCESS_EXIT" } },
      { ...receipt, github: { actor: "shrey16", run_id: 123456788, run_attempt: 1 } },
      { ...receipt, extra: true },
    ]) {
      expect(() => validateLeanUpgradeWaiver(hostile, expected)).toThrow()
    }
    expect(() =>
      validateLeanUpgradeWaiver({ ...receipt, github: { ...receipt.github, actor: "other-owner" } }, expected),
    ).toThrow("dispatcher is not authorized")
  })

  test("accepts only a complete same-source, same-run packaged WSL host receipt", async () => {
    const module = await import("../../script/lean-cohort.mjs")
    expect(module.validateLeanWslReceipt).toBeFunction()
    const desktopSha256 = "d".repeat(64)
    const runtimeManifestSha256 = "e".repeat(64)
    const receipt = {
      schema: "bharatcode-wsl-scenarios-9-10-v1",
      result: "PASS",
      source_sha: sourceSha,
      desktop_sha256: desktopSha256,
      runtime_manifest_sha256: runtimeManifestSha256,
      runtime: {
        manifest_source_sha: sourceSha,
        executed_source_sha: sourceSha,
        manifest_sha256: "f".repeat(64),
        executed_sha256: "f".repeat(64),
      },
      github: { run_id: 123456789, run_attempt: 1 },
      identity: { distro_sha256: "1".repeat(64), user_sha256: "2".repeat(64), uid: 1000 },
      scenarios: { "9": true, "10": true },
      completed_at: completedAt,
    }
    const expected = { ...bindings, desktop_sha256: desktopSha256, runtime_manifest_sha256: runtimeManifestSha256 }
    expect(module.validateLeanWslReceipt(receipt, expected)).toEqual(receipt)
    for (const hostile of [
      { ...receipt, source_sha: "0".repeat(40) },
      { ...receipt, github: { run_id: 123456788, run_attempt: 1 } },
      { ...receipt, github: { run_id: 123456789, run_attempt: 2 } },
      { ...receipt, desktop_sha256: "0".repeat(64) },
      { ...receipt, scenarios: { "9": true } },
      { ...receipt, scenarios: { "9": true, "10": false } },
    ]) {
      expect(() => module.validateLeanWslReceipt(hostile, expected)).toThrow()
    }
  })
})
