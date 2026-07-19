import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { REQUIRED_COHORT_KEYS } from "../../script/lean-cohort.mjs"

const workflowPath = resolve(import.meta.dir, "../../../../.github/workflows/bharatcode-next-beta-candidate.yml")
const checkout = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const upload = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const download = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
const attest = "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6"
const acceptedWslSha = "a30c6923f2f532258de58d84b65445198be1b351"
const currentBetaFixture = "packages/desktop/test/fixtures/current-beta-windows-x64.json"
const cohortSubjectNames = [
  "bharatcode-${CLI_VERSION}.tgz",
  "bharatcode-darwin-arm64-${CLI_VERSION}.tgz",
  "bharatcode-darwin-x64-${CLI_VERSION}.tgz",
  "bharatcode-darwin-x64-baseline-${CLI_VERSION}.tgz",
  "bharatcode-linux-arm64-${CLI_VERSION}.tgz",
  "bharatcode-linux-arm64-musl-${CLI_VERSION}.tgz",
  "bharatcode-linux-x64-${CLI_VERSION}.tgz",
  "bharatcode-linux-x64-baseline-${CLI_VERSION}.tgz",
  "bharatcode-linux-x64-baseline-musl-${CLI_VERSION}.tgz",
  "bharatcode-linux-x64-musl-${CLI_VERSION}.tgz",
  "bharatcode-windows-arm64-${CLI_VERSION}.tgz",
  "bharatcode-windows-x64-${CLI_VERSION}.tgz",
  "bharatcode-windows-x64-baseline-${CLI_VERSION}.tgz",
  "bharatcode-desktop-next-beta-linux-x64.AppImage",
  "bharatcode-desktop-next-beta-linux-x64.deb",
  "bharatcode-desktop-next-beta-mac-arm64.zip",
  "bharatcode-desktop-next-beta-mac-x64.zip",
  "bharatcode-desktop-next-beta-win-x64.exe",
  "bharatcode-upgrade-rollback-windows-x64.json",
  "bharatcode-wsl-scenarios-9-10.json",
]
const internalWslInputs = [
  "manifest.json",
  "bharatcode-runtime-linux-x64-glibc",
  "bharatcode-wsl-runtime-manifest.json",
]

async function source() {
  if (Bun.env.BHARATCODE_CANDIDATE_WORKFLOW_SOURCE) {
    return Buffer.from(Bun.env.BHARATCODE_CANDIDATE_WORKFLOW_SOURCE, "base64").toString("utf8")
  }
  expect(await Bun.file(workflowPath).exists()).toBeTrue()
  return Bun.file(workflowPath).text()
}

function parse(value: string) {
  return Bun.YAML.parse(value) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } }
    permissions: Record<string, string>
    jobs: Record<
      string,
      {
        needs?: string[]
        permissions?: Record<string, string>
        "runs-on"?: string | string[]
        steps?: { name?: string; run?: string; uses?: string }[]
      }
    >
  }
}

function runStep(value: string, job: string, name: string) {
  return parse(value).jobs[job].steps?.find((step) => step.name === name)?.run ?? ""
}

function bashArray(run: string, name: string) {
  return (
    new RegExp(`(?:^|\\n)\\s*${name}=\\(\\n([\\s\\S]*?)\\n\\s*\\)`, "u")
      .exec(run)?.[1]
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^"|"$/gu, "")) ?? []
  )
}

function upgradeValidationViolations(value: string) {
  const run = runStep(value, "assemble-cohort", "Rehash, close, and validate final manifest")
  const required = [
    'from "./packages/desktop/scripts/lean-upgrade-receipt.mjs"',
    "parseCurrentBetaFixtureBytes",
    "parseLeanUpgradeReceiptBytes(new Uint8Array",
    `const currentBetaFixturePath = "${currentBetaFixture}"`,
    "const currentBeta = parseCurrentBetaFixtureBytes",
    'const upgradePath = one("bharatcode-upgrade-rollback-windows-x64.json")',
    "source_sha: process.env.SOURCE_SHA",
    "run_id: process.env.GITHUB_RUN_ID",
    "run_attempt: process.env.GITHUB_RUN_ATTEMPT",
    "current_beta: currentBeta",
    "candidate: { key: expectedKeys[17], filename: windows.filename, bytes: windows.bytes, sha256: windows.sha256 }",
  ]
  return [
    ...required.filter((fragment) => !run.includes(fragment)),
    ...(run.indexOf("parseLeanUpgradeReceiptBytes(") < run.indexOf("const manifest =") ? [] : ["validation order"]),
  ]
}

function authorityViolations(value: string) {
  const workflow = parse(value)
  const permissions = [
    workflow.permissions,
    ...Object.values(workflow.jobs).flatMap((job) => (job.permissions ? [job.permissions] : [])),
  ]
  const forbidden = [
    /gh\s+release\s+(?:create|upload)/iu,
    /npm\s+publish/iu,
    /repository_dispatch/iu,
    /homebrew.*(?:push|update)/iu,
    /(?:updater|channel).*(?:promote|publish)/iu,
    /--clobber/iu,
    /(?:@|:)latest\b/iu,
    /npm\s+(?:dist-tag|tag).*\bnext\b/iu,
    /BHARATCODE_ALLOW_UNSIGNED_(?:MAC|WINDOWS)/u,
  ]
  return [
    ...permissions.flatMap((item) =>
      Object.entries(item).flatMap(([name, access]) =>
        (name === "contents" && access === "read") ||
        (name === "id-token" && access === "write") ||
        (name === "attestations" && access === "write")
          ? []
          : [`${name}:${access}`],
      ),
    ),
    ...forbidden.flatMap((pattern) => (pattern.test(value) ? [pattern.source] : [])),
    ...(value.includes("overwrite: false") ? [] : ["overwrite"]),
  ]
}

describe("lean next-beta candidate workflow", () => {
  test("is manual-only, default-branch-only, and binds one exact source plus the accepted WSL gate", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["source_sha"])
    expect(value).toContain("^[0-9a-f]{40}$")
    expect(value).toContain("github.ref == 'refs/heads/dev'")
    expect(value).toContain("github.sha")
    expect(value).toContain("inputs.source_sha")
    expect(value).toContain("ref: ${{ inputs.source_sha }}")
    expect(value).toContain("next-beta-${source_sha:0:12}")
    expect(value).toContain(acceptedWslSha)
    expect(value).toContain("git merge-base --is-ancestor")
  })

  test("pins every action and Bun while denying publication and overwrite authority", async () => {
    const value = await source()
    const actionUses = [...value.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1])
    expect(actionUses.length).toBeGreaterThan(20)
    expect(new Set(actionUses)).toEqual(new Set([checkout, setupBun, upload, download, attest]))
    expect(actionUses.every((item) => /@[0-9a-f]{40}$/u.test(item))).toBeTrue()
    expect(value).toContain("bun-version-file: package.json")
    expect(value).toContain('"packageManager": "bun@1.3.14"')
    expect(authorityViolations(value)).toEqual([])
  })

  test("builds and verifies the complete same-run cohort before the final manifest", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      [
        "accept-cli-native",
        "accept-wsl",
        "admit-source",
        "assemble-cohort",
        "build-cli",
        "package-linux",
        "package-macos",
        "package-windows",
        "upgrade-rollback-windows-x64",
      ].sort(),
    )
    expect(workflow.jobs["assemble-cohort"].needs?.sort()).toEqual(
      [
        "accept-cli-native",
        "accept-wsl",
        "admit-source",
        "build-cli",
        "package-linux",
        "package-macos",
        "package-windows",
        "upgrade-rollback-windows-x64",
      ].sort(),
    )
    for (const key of REQUIRED_COHORT_KEYS) expect(value).toContain(key)
    expect(value).toContain("bharatcode-next-beta-cohort.json")
    expect(value).toContain("bharatcode-next-beta-cohort-v1")
    expect(value).toContain("canonicalLeanJson")
    expect(value).toContain("validateLeanCohort")
    expect(value).toContain("github.run_id")
    expect(value).toContain("github.run_attempt")
  })

  test("requires native package, signature, notarization, WSL, CLI, attestation, and API checks", async () => {
    const value = await source()
    for (const required of [
      "Get-AuthenticodeSignature",
      "StatusMessage",
      "TimeStamperCertificate",
      "codesign --verify --deep --strict",
      "spctl --assess",
      "xcrun stapler validate",
      "lipo -archs",
      "dpkg-deb --field",
      "sudo apt-get install",
      "wsl-windows-acceptance.mjs",
      "validateLeanWslReceipt",
      "npm install --global",
      "npx --no-install bharatcode --version",
      "gh attestation verify",
      "/actions/runs/${{ github.run_id }}",
      "artifact-digest",
      "https://slsa.dev/provenance/v1",
    ]) {
      expect(value).toContain(required)
    }
    expect(value).toContain("macos-14")
    expect(value).toContain("macos-15-intel")
    expect(value).toContain("windows-2025")
    expect(value).toContain("ubuntu-24.04")
  })

  test("uses the exact checked-in current-beta fixture for packaged upgrade acceptance", async () => {
    const value = await source()
    expect(await Bun.file(resolve(import.meta.dir, `../../../../${currentBetaFixture}`)).exists()).toBeTrue()
    expect(value).toContain(`--fixture ${currentBetaFixture}`)
    expect(value).not.toContain("packages/desktop/test/fixtures/lean-current-beta.json")
  })

  test("attests exactly every cohort subject while excluding closed internal WSL inputs", async () => {
    const value = await source()
    const run = runStep(value, "assemble-cohort", "Verify every artifact attestation against exact source and signer")
    expect(bashArray(run, "cohort_subjects")).toEqual(cohortSubjectNames)
    expect(cohortSubjectNames).toHaveLength(REQUIRED_COHORT_KEYS.length)
    expect(cohortSubjectNames).not.toContain("bharatcode-wsl-runtime-manifest.json")
    for (const internal of internalWslInputs) expect(run).toContain(`! -name '${internal}'`)
    expect(run).toContain('[[ "${#actual_subjects[@]}" -eq "${#cohort_subjects[@]}" ]]')
    expect(bashArray(run.replace('"bharatcode-wsl-scenarios-9-10.json"\n', ""), "cohort_subjects")).not.toEqual(
      cohortSubjectNames,
    )
    expect(run.replace("! -name 'bharatcode-wsl-runtime-manifest.json'", "")).not.toContain(
      "! -name 'bharatcode-wsl-runtime-manifest.json'",
    )
  })

  test("canonically validates the upgrade receipt against fixture and assembled candidate identity", async () => {
    const value = await source()
    expect(upgradeValidationViolations(value)).toEqual([])
    expect(
      upgradeValidationViolations(
        value.replace(
          "parseLeanUpgradeReceiptBytes(new Uint8Array(await Bun.file(upgradePath)",
          "removedUpgradeReceiptParser(new Uint8Array(await Bun.file(upgradePath)",
        ),
      ),
    ).not.toEqual([])
    expect(
      upgradeValidationViolations(
        value.replace(
          `const currentBetaFixturePath = "${currentBetaFixture}"`,
          'const currentBetaFixturePath = "packages/desktop/test/fixtures/drift.json"',
        ),
      ),
    ).not.toEqual([])
    expect(
      upgradeValidationViolations(value.replace("filename: windows.filename", 'filename: "substituted.exe"')),
    ).not.toEqual([])
    expect(upgradeValidationViolations(value.replace("bytes: windows.bytes", "bytes: 1"))).not.toEqual([])
    expect(
      upgradeValidationViolations(
        value.replace("bytes: windows.bytes, sha256: windows.sha256", 'bytes: windows.bytes, sha256: "0".repeat(64)'),
      ),
    ).not.toEqual([])
  })

  test("runs the real Windows upgrade harness and validates its receipt before attestation", async () => {
    const value = await source()
    const job = parse(value).jobs["upgrade-rollback-windows-x64"]
    expect(job["runs-on"]).toBe("windows-2025")
    const run = runStep(value, "upgrade-rollback-windows-x64", "Run real packaged upgrade and rollback acceptance")
    for (const required of [
      "packages/desktop/scripts/lean-upgrade-acceptance.mjs",
      `--fixture ${currentBetaFixture}`,
      "--candidate candidate-input/bharatcode-desktop-next-beta-win-x64.exe",
      "--source-sha '${{ inputs.source_sha }}'",
      '--acceptance-dir "$env:RUNNER_TEMP\\bharatcode-upgrade-acceptance"',
    ]) {
      expect(run).toContain(required)
    }
    expect(run).not.toMatch(/extract|mock|ShareNext|share.*https?:/iu)
    const steps = job.steps ?? []
    const harness = steps.findIndex((step) => step.name === "Run real packaged upgrade and rollback acceptance")
    const validation = steps.findIndex((step) => step.name === "Validate packaged upgrade receipt before attestation")
    const attestation = steps.findIndex((step) => step.name === "Attest upgrade and rollback receipt")
    expect(harness).toBeGreaterThan(-1)
    expect(validation).toBeGreaterThan(harness)
    expect(attestation).toBeGreaterThan(validation)
    const validator = steps[validation]?.run ?? ""
    for (const required of [
      "parseCurrentBetaFixtureBytes",
      "parseLeanUpgradeReceiptBytes",
      currentBetaFixture,
      "candidate-input/bharatcode-desktop-next-beta-win-x64.exe",
      "process.env.GITHUB_RUN_ID",
      "process.env.GITHUB_RUN_ATTEMPT",
      "process.env.SOURCE_SHA",
    ]) {
      expect(validator).toContain(required)
    }
  })

  test("hostile authority, identity, mutability, and cohort regressions are observable", async () => {
    const value = await source()
    expect(authorityViolations(value.replace("contents: read", "contents: write"))).not.toEqual([])
    expect(authorityViolations(value.replace("overwrite: false", "overwrite: true"))).not.toEqual([])
    expect(authorityViolations(`${value}\n# npm publish\n`)).not.toEqual([])
    expect(authorityViolations(`${value}\n# BHARATCODE_ALLOW_UNSIGNED_WINDOWS=1\n`)).not.toEqual([])
    expect(value.replace("ref: ${{ inputs.source_sha }}", "ref: dev")).not.toContain("ref: ${{ inputs.source_sha }}")
    expect(value.replace(checkout, "actions/checkout@v7")).toContain("actions/checkout@v7")
    expect(value.replaceAll("desktop-windows-x64", "desktop-windows-arm64")).not.toContain("desktop-windows-x64")
  })
})
