import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
  REQUIRED_COHORT_KEYS,
  canonicalLeanJson,
  parseLeanCohortBytes,
  validateLeanCohort,
} from "../../script/lean-cohort.mjs"

const sourceSha = "3b09dcff0d7e8ad7487c6d40199b704ed0712005"
const bindings = { source_sha: sourceSha, run_id: "123456789", run_attempt: "1" }
const completedAt = "2026-07-20T10:00:00.000Z"
const adapterPath = resolve(import.meta.dir, "../../script/preliminary-jit-evidence-cli.mjs")

function signing(key: string) {
  if (key === "desktop-windows-x64") return "authenticode"
  if (key.startsWith("desktop-macos-")) return "apple-notarized-stapled"
  if (key.endsWith("receipt") || key === "wsl-scenarios-9-10" || key === "upgrade-rollback-windows-x64") {
    return "acceptance-receipt"
  }
  return "not-applicable"
}

function platform(key: string) {
  if (key.includes("windows") || key === "upgrade-rollback-windows-x64") return "windows"
  if (key.includes("darwin") || key.includes("macos")) return "macos"
  if (key.includes("linux")) return "linux"
  if (key === "wsl-scenarios-9-10") return "windows-wsl2"
  return "npm"
}

function arch(key: string) {
  if (key === "cli-bharatcode") return "universal"
  if (key.includes("arm64")) return "arm64"
  return "x64"
}

function artifact(key: string, index: number) {
  const sha256 = index.toString(16).padStart(64, "0")
  const attestationSha256 = (index + 100).toString(16).padStart(64, "0")
  return {
    key,
    platform: platform(key),
    arch: arch(key),
    filename: key.startsWith("cli-") ? `${key}-1.15.10.tgz` : `${key}.json`,
    bytes: 1_000 + index,
    sha256,
    artifact_attestation: {
      filename: `${key}.intoto.jsonl`,
      bytes: 2_000 + index,
      sha256: attestationSha256,
      subject_sha256: sha256,
      predicate_type: "https://slsa.dev/provenance/v1",
    },
    signing: signing(key),
    completed_at: "2026-07-20T09:59:00.000Z",
  }
}

function manifest() {
  const artifacts = REQUIRED_COHORT_KEYS.map(artifact)
  return {
    schema: "bharatcode-next-beta-cohort-v1",
    repository: "BharatCode-ai/bharatcode-desktop",
    source_sha: sourceSha,
    candidate_tag: `next-beta-${sourceSha.slice(0, 12)}`,
    desktop_version: "1.15.21",
    cli_version: "1.15.10",
    wsl_runtime_version: "1.15.21",
    channel: "beta",
    workflow: ".github/workflows/bharatcode-next-beta-candidate.yml",
    run_id: bindings.run_id,
    run_attempt: bindings.run_attempt,
    wsl_receipt_sha256: artifacts.find((item) => item.key === "wsl-scenarios-9-10")!.sha256,
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

  test("validates the signed cohort through the host-controller stdin adapter", async () => {
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
          '"schema":"bharatcode-next-beta-cohort-v1"',
          '"schema":"bharatcode-next-beta-cohort-v1","schema":"bharatcode-next-beta-cohort-v1"',
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
        Buffer.from('{"schema":"bharatcode-next-beta-cohort-v1","schema":"bharatcode-next-beta-cohort-v1"}'),
        bindings,
      ),
    ).toThrow(/canonical|duplicate|keys/i)
  })

  test("rejects wrong source, run, attempt, or derived candidate tag", () => {
    for (const value of [
      { ...manifest(), source_sha: "0".repeat(40) },
      { ...manifest(), run_id: "123456788" },
      { ...manifest(), run_attempt: "2" },
      { ...manifest(), candidate_tag: "next-beta-latest" },
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

  test("rejects wrong size, digest, attestation subject, or unsigned platform output", () => {
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
        value.artifacts.find((item) => item.key === "desktop-windows-x64")!.signing = "not-applicable"
        return value
      },
      () => {
        const value = manifest()
        value.artifacts[1].signing = "authenticode"
        return value
      },
    ]
    for (const hostile of cases) expect(() => validateLeanCohort(hostile(), bindings)).toThrow()
  })

  test("rejects incomplete receipt records, wrong WSL binding, version drift, and late artifact completion", () => {
    const cases = [
      () => {
        const value = manifest()
        value.artifacts.pop()
        return value
      },
      () => ({ ...manifest(), wsl_receipt_sha256: "f".repeat(64) }),
      () => ({ ...manifest(), wsl_runtime_version: "1.15.20" }),
      () => ({ ...manifest(), cli_version: "1.15.10-01" }),
      () => {
        const value = manifest()
        value.artifacts[0].completed_at = "2026-07-20T10:00:00.001Z"
        return value
      },
    ]
    for (const hostile of cases) expect(() => validateLeanCohort(hostile(), bindings)).toThrow()
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
