import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"

import { validateLeanCohort, validateLeanWslReceipt } from "../../script/lean-cohort.mjs"
import {
  canonicalPreliminaryUnsignedWslJson,
  validatePreliminaryUnsignedWslReceipt,
} from "../../script/lean-preliminary-unsigned-wsl.mjs"

const root = resolve(import.meta.dir, "../../../..")
const workflowPath = resolve(root, ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml")
const finalWorkflowPath = resolve(root, ".github/workflows/bharatcode-next-beta-candidate.yml")
const acceptedWslSha = "f223e2c6b53f567667491f6f1e5667c42fb73fa0"
const finalWorkflowSha256 = "79b4843c8249c820d0c58306aa2d39bddd0e8f52cc39ede627acf1ff9be9459f"
const label = "bharatcode-acceptance-${{ github.run_id }}-${{ github.run_attempt }}"
const checkout = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const upload = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const download = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
const attest = "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6"
const frozenWslPaths = [
  "packages/desktop/electron-builder.config.ts",
  "packages/desktop/scripts/stage-wsl-runtime.ts",
  "packages/desktop/scripts/wsl-windows-acceptance.mjs",
  "packages/desktop/src/main/index.ts",
  "packages/desktop/src/main/ipc.ts",
  "packages/desktop/src/main/server.ts",
  "packages/desktop/src/main/windows.ts",
  "packages/desktop/src/main/wsl-*",
  "packages/desktop/src/preload/index.ts",
  "packages/desktop/src/preload/types.ts",
  "packages/desktop/src/renderer/index.tsx",
  "packages/opencode/script/build.ts",
  "packages/opencode/src/cli/cmd/serve.ts",
  "packages/opencode/src/server/wsl-desktop-transport.ts",
] as const

type Step = {
  name?: string
  run?: string
  uses?: string
  shell?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
}

type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } }
  permissions: Record<string, string>
  env: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string[] | string
      permissions?: Record<string, string>
      "runs-on"?: string | string[]
      steps?: Step[]
    }
  >
}

async function source() {
  expect(await Bun.file(workflowPath).exists()).toBeTrue()
  return Bun.file(workflowPath).text()
}

function parse(value: string) {
  return Bun.YAML.parse(value) as Workflow
}

function step(value: string, job: string, name: string) {
  const result = parse(value).jobs[job]?.steps?.find((item) => item.name === name)
  if (!result) throw new Error(`missing ${job}/${name}`)
  return result
}

function renderLabels(value: string, runId: string, runAttempt: string) {
  if (!/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error("test run identity is invalid")
  }
  const labels = parse(value).jobs["accept-preliminary-unsigned-wsl"]?.["runs-on"]
  if (!Array.isArray(labels)) throw new Error("preliminary runner labels are not closed")
  return labels.map((item) =>
    item.replaceAll("${{ github.run_id }}", runId).replaceAll("${{ github.run_attempt }}", runAttempt),
  )
}

const sha256 = (value: string | ArrayBuffer | Uint8Array) =>
  createHash("sha256")
    .update(value instanceof ArrayBuffer ? new Uint8Array(value) : value)
    .digest("hex")
const sourceSha = "9".repeat(40)
const bindings = {
  source_sha: sourceSha,
  run_id: "123456789",
  run_attempt: "2",
  unsigned_installer_bytes: 4096,
  unsigned_installer_sha256: "a".repeat(64),
  installed_desktop_bytes: 8192,
  installed_desktop_sha256: "b".repeat(64),
  runtime_manifest_sha256: "c".repeat(64),
  harness_sha256: "d".repeat(64),
}

function receipt() {
  return {
    schema: "bharatcode-wsl-preliminary-unsigned-v1",
    evidence_class: "PRELIMINARY_UNSIGNED",
    result: "PRELIMINARY_UNSIGNED",
    signature_status: "PRELIMINARY_UNSIGNED",
    provenance_status: "PRELIMINARY_UNSIGNED",
    promotable: false,
    composable: false,
    repository: "BharatCode-ai/bharatcode-desktop",
    workflow: ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
    source_sha: sourceSha,
    github: { run_id: 123456789, run_attempt: 2 },
    unsigned_installer: {
      filename: "bharatcode-desktop-preliminary-unsigned-test-win-x64.exe",
      bytes: 4096,
      sha256: "a".repeat(64),
    },
    installed_desktop: { filename: "BharatCode Beta.exe", bytes: 8192, sha256: "b".repeat(64) },
    runtime_manifest_sha256: "c".repeat(64),
    runtime: {
      manifest_source_sha: sourceSha,
      executed_source_sha: sourceSha,
      manifest_sha256: "e".repeat(64),
      executed_sha256: "e".repeat(64),
    },
    harness: {
      contract: "packages/desktop/scripts/wsl-windows-acceptance.mjs",
      contract_sha256: "d".repeat(64),
      authority: "DIAGNOSTIC",
    },
    identity: { distro_sha256: "f".repeat(64), user_sha256: "1".repeat(64), uid: 1000 },
    scenarios: { "9": true, "10": true },
    completed_at: "2026-07-20T00:00:00.000Z",
  }
}

function installedAcceptanceViolations(value: string) {
  const build = step(value, "package-preliminary-unsigned-windows", "Build and verify unsigned TEST-only NSIS")
  const buildRun = build.run ?? ""
  const uploadStep = step(
    value,
    "package-preliminary-unsigned-windows",
    "Upload same-run unsigned TEST-only package inputs",
  )
  const uploadPath = String(uploadStep.with?.path ?? "")
  const install =
    step(value, "accept-preliminary-unsigned-wsl", "Install unsigned NSIS into a create-only root").run ?? ""
  const acceptance =
    step(
      value,
      "accept-preliminary-unsigned-wsl",
      "Run installed Desktop through the real WSL contract and write preliminary evidence",
    ).run ?? ""
  return [
    ...(build.env?.BHARATCODE_ALLOW_UNSIGNED_WINDOWS === "1" ? [] : ["explicit unsigned build authority"]),
    ...(buildRun.includes("electron-builder --win nsis --x64") ? [] : ["NSIS build"]),
    ...(buildRun.includes('Status -ne "NotSigned"') &&
    buildRun.includes("SignerCertificate") &&
    buildRun.includes("TimeStamperCertificate")
      ? []
      : ["unsigned package proof"]),
    ...(uploadPath.includes("bharatcode-wsl-runtime-manifest.json") &&
    uploadPath.includes("bharatcode-runtime-linux-x64-glibc")
      ? []
      : ["adjacent raw runtime inputs"]),
    ...(install.includes("Test-Path $installRoot") && install.includes('"/S"') && install.includes('"/D=$installRoot"')
      ? []
      : ["create-only isolated NSIS install"]),
    ...(install.includes('Join-Path $installRoot "BharatCode Beta.exe"') &&
    install.includes("INSTALLED_DESKTOP_EXE") &&
    install.includes("Installed preliminary Desktop version drift")
      ? []
      : ["installed Desktop resolution"]),
    ...(acceptance.includes('"--desktop-exe", process.env.INSTALLED_DESKTOP_EXE') &&
    !acceptance.includes('"--desktop-exe", process.env.UNSIGNED_INSTALLER_PATH')
      ? []
      : ["installed Desktop harness entrypoint"]),
    ...(acceptance.includes('const manifest = "preliminary-input/bharatcode-wsl-runtime-manifest.json"') &&
    acceptance.includes('const runtime = "preliminary-input/bharatcode-runtime-linux-x64-glibc"')
      ? []
      : ["raw runtime harness binding"]),
    ...(acceptance.includes("sha256: result.evidence.desktop_sha256") ? [] : ["harness Desktop digest binding"]),
    ...(acceptance.includes("const result = await runPreliminaryWindowsAcceptance(argv)") &&
    acceptance.includes('result.authority !== "PRELIMINARY_UNSIGNED"')
      ? []
      : ["preliminary-only harness authority"]),
  ]
}

function sourceAdmissionViolations(value: string) {
  const workflow = parse(value)
  const admission = step(value, "admit-source", "Admit immutable preliminary source").run ?? ""
  const checkouts = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((item) => item.uses === checkout),
  )
  return [
    ...(Object.keys(workflow.on).length === 1 && Object.hasOwn(workflow.on, "workflow_dispatch")
      ? []
      : ["manual-only trigger"]),
    ...(Object.keys(workflow.on.workflow_dispatch.inputs).join(",") === "source_sha" ? [] : ["closed source input"]),
    ...(workflow.jobs["admit-source"].if === "github.ref == 'refs/heads/dev'" ? [] : ["dev-only admission"]),
    ...(admission.includes('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]') &&
    admission.includes('[[ "$EVENT_SHA" == "$SOURCE_SHA" ]]') &&
    admission.includes('[[ "$GITHUB_SHA" == "$SOURCE_SHA" ]]') &&
    admission.includes('[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]')
      ? []
      : ["exact source identity"]),
    ...(admission.includes(`git merge-base --is-ancestor "$ACCEPTED_WSL_SOURCE_SHA" "$SOURCE_SHA"`) &&
    frozenWslPaths.every((path) => admission.includes(path))
      ? []
      : ["accepted WSL source closure"]),
    ...(workflow.env.SOURCE_SHA === "${{ inputs.source_sha }}" &&
    checkouts.every((item) => ["${{ inputs.source_sha }}", "${{ env.SOURCE_SHA }}"].includes(String(item.with?.ref)))
      ? []
      : ["checkout source binding"]),
  ]
}

function runArtifactBindingViolations(value: string) {
  const workflow = parse(value)
  const names = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((item) => (typeof item.with?.name === "string" ? [item.with.name] : [])),
  )
  return [
    ...(names.length === 5 && names.every((name) => name.endsWith("-${{ github.run_id }}-${{ github.run_attempt }}"))
      ? []
      : ["same-run artifact names"]),
    ...(JSON.stringify(workflow.jobs["accept-preliminary-unsigned-wsl"].needs) ===
    JSON.stringify(["admit-source", "package-preliminary-unsigned-windows"])
      ? []
      : ["acceptance producer chain"]),
  ]
}

describe("preliminary unsigned Windows/WSL acceptance workflow", () => {
  test("is a dedicated manual-only exact-source workflow while the final signed workflow stays byte-identical", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["source_sha"])
    expect(workflow.jobs["admit-source"].if).toBe("github.ref == 'refs/heads/dev'")
    expect(value).toContain("^[0-9a-f]{40}$")
    expect(value).toContain('[[ "$EVENT_SHA" == "$SOURCE_SHA" ]]')
    expect(value).toContain('[[ "$GITHUB_SHA" == "$SOURCE_SHA" ]]')
    expect(value).toContain("ref: ${{ inputs.source_sha }}")
    expect(value).toContain(acceptedWslSha)
    const admission = step(value, "admit-source", "Admit immutable preliminary source").run ?? ""
    for (const path of frozenWslPaths) expect(admission).toContain(path)
    expect(sha256(await Bun.file(finalWorkflowPath).arrayBuffer())).toBe(finalWorkflowSha256)
    expect(sourceAdmissionViolations(value)).toEqual([])
    for (const hostile of [
      value.replace("^[0-9a-f]{40}$", "^[0-9A-Fa-f]{40}$"),
      value.replace('[[ "$EVENT_SHA" == "$SOURCE_SHA" ]]\n', ""),
      value.replace("github.ref == 'refs/heads/dev'", "github.ref != ''"),
      value.replace("ref: ${{ env.SOURCE_SHA }}", "ref: dev"),
    ]) {
      expect(hostile).not.toBe(value)
      expect(sourceAdmissionViolations(hostile)).not.toEqual([])
    }
  })

  test("derives a disjoint immutable run-attempt runner label with no static or operator route", async () => {
    const value = await source()
    const first = renderLabels(value, "29722640762", "1")
    const second = renderLabels(value, "29722640762", "2")
    expect(first).toEqual(["self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29722640762-1"])
    expect(second).toEqual(["self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29722640762-2"])
    expect(first.at(-1)).not.toBe(second.at(-1))
    expect(first.at(-1)).toMatch(/^bharatcode-acceptance-[1-9][0-9]*-[1-9][0-9]*$/)
    expect(parse(value).jobs["accept-preliminary-unsigned-wsl"]["runs-on"]).toEqual([
      "self-hosted",
      "windows",
      "x64",
      "wsl2",
      label,
    ])
    expect(() => renderLabels(value.replace(label, "bharatcode-acceptance"), "29722640762", "1")).not.toThrow()
    expect(renderLabels(value.replace(label, "bharatcode-acceptance"), "29722640762", "1").at(-1)).toBe(
      renderLabels(value.replace(label, "bharatcode-acceptance"), "29722640762", "2").at(-1),
    )
    expect(JSON.stringify(parse(value).jobs["accept-preliminary-unsigned-wsl"]["runs-on"])).not.toMatch(
      /inputs\.|vars\.|secrets\./,
    )
    expect(() => renderLabels(value, "0", "1")).toThrow()
    expect(() => renderLabels(value, "1", "01")).toThrow()
    expect(runArtifactBindingViolations(value)).toEqual([])
    expect(
      runArtifactBindingViolations(
        value.replace(
          "preliminary-wsl-unsigned-windows-${{ github.run_id }}-${{ github.run_attempt }}",
          "preliminary-wsl-unsigned-windows-${{ github.run_id }}-1",
        ),
      ),
    ).not.toEqual([])
  })

  test("builds an unsigned NSIS, installs it in a create-only isolated root, and runs the installed app with raw runtime inputs", async () => {
    const value = await source()
    expect(installedAcceptanceViolations(value)).toEqual([])
    for (const hostile of [
      value.replace('BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "1"', 'BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "0"'),
      value.replace("electron-builder --win nsis --x64", "electron-builder --win dir --x64"),
      value.replace('Status -ne "NotSigned"', 'Status -ne "Valid"'),
      value.replace('"/D=$installRoot"', '"/D=C:\\\\Program Files\\\\BharatCode"'),
      value.replace(
        '"--desktop-exe", process.env.INSTALLED_DESKTOP_EXE',
        '"--desktop-exe", process.env.UNSIGNED_INSTALLER_PATH',
      ),
      value.replace("            bharatcode-runtime-linux-x64-glibc\n", ""),
      value.replace("sha256: result.evidence.desktop_sha256", "sha256: bindings.installed_desktop_sha256"),
      value.replace(
        "const result = await runPreliminaryWindowsAcceptance(argv)",
        "const result = await runWindowsAcceptance(argv)",
      ),
    ]) {
      expect(hostile).not.toBe(value)
      expect(installedAcceptanceViolations(hostile)).not.toEqual([])
    }
  })

  test("validates one closed non-promotable receipt and final consumers reject it", () => {
    const value = receipt()
    expect(validatePreliminaryUnsignedWslReceipt(value, bindings)).toEqual(value)
    expect(canonicalPreliminaryUnsignedWslJson(value, bindings)).toBe(`${JSON.stringify(value)}\n`)
    for (const hostile of [
      { ...value, extra: true },
      { ...value, schema: "bharatcode-wsl-scenarios-9-10-v1" },
      { ...value, result: "PASS" },
      { ...value, signature_status: "NotSigned" },
      { ...value, provenance_status: "SLSA" },
      { ...value, promotable: true },
      { ...value, composable: true },
      { ...value, source_sha: "8".repeat(40) },
      { ...value, github: { ...value.github, run_attempt: 1 } },
      { ...value, unsigned_installer: { ...value.unsigned_installer, sha256: "0".repeat(64) } },
      { ...value, installed_desktop: { ...value.installed_desktop, sha256: "0".repeat(64) } },
      { ...value, runtime: { ...value.runtime, executed_sha256: "0".repeat(64) } },
      { ...value, harness: { ...value.harness, authority: "PASS" } },
      { ...value, identity: { ...value.identity, uid: 0 } },
      { ...value, scenarios: { "9": true, "10": false } },
    ]) {
      expect(() => validatePreliminaryUnsignedWslReceipt(hostile, bindings)).toThrow()
    }
    expect(() =>
      validateLeanWslReceipt(value, {
        source_sha: bindings.source_sha,
        run_id: bindings.run_id,
        run_attempt: bindings.run_attempt,
        desktop_sha256: bindings.installed_desktop_sha256,
        runtime_manifest_sha256: bindings.runtime_manifest_sha256,
      }),
    ).toThrow()
    expect(() =>
      validateLeanCohort(value, {
        source_sha: bindings.source_sha,
        run_id: bindings.run_id,
        run_attempt: bindings.run_attempt,
      }),
    ).toThrow()
  })

  test("attests and uploads only preliminary evidence with no final-cohort or publication authority", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      [
        "accept-preliminary-unsigned-wsl",
        "admit-source",
        "build-wsl-runtime",
        "package-preliminary-unsigned-windows",
      ].sort(),
    )
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.jobs["accept-preliminary-unsigned-wsl"].permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    })
    const uses = [...value.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1])
    expect(new Set(uses)).toEqual(new Set([checkout, setupBun, upload, download, attest]))
    expect(uses.every((item) => /@[0-9a-f]{40}$/u.test(item))).toBeTrue()
    expect(value).not.toMatch(
      /cp2-|wsl-scenarios-9-10|wsl_receipt_sha256|bharatcode-next-beta-cohort|assemble-cohort/iu,
    )
    expect(value).not.toMatch(/gh\s+release|npm\s+publish|repository_dispatch|workflow_run|workflow_call|ShareNext/iu)
    expect(value).not.toMatch(/contents:\s*write|packages:\s*write|deployments:\s*write/iu)
    const attestation = step(value, "accept-preliminary-unsigned-wsl", "Attest preliminary unsigned evidence")
    expect(attestation.with?.["subject-path"]).toBe("bharatcode-wsl-preliminary-unsigned.json")
    const uploadStep = step(value, "accept-preliminary-unsigned-wsl", "Upload run-attempt-scoped preliminary evidence")
    expect(uploadStep.with?.name).toBe("preliminary-wsl-evidence-${{ github.run_id }}-${{ github.run_attempt }}")
    expect(uploadStep.with?.path).toBe(
      "bharatcode-wsl-preliminary-unsigned.json\nbharatcode-wsl-preliminary-unsigned.json.intoto.jsonl\n",
    )
    const otherWorkflows = readdirSync(resolve(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/u.test(name) && name !== "bharatcode-preliminary-unsigned-wsl.yml")
      .map((name) => Bun.file(resolve(root, ".github/workflows", name)).text())
    return Promise.all(otherWorkflows).then((sources) => {
      expect(sources.join("\n")).not.toMatch(
        /bharatcode-wsl-preliminary-unsigned-v1|bharatcode-wsl-preliminary-unsigned\.json|preliminary-wsl-evidence-/u,
      )
    })
  })
})
