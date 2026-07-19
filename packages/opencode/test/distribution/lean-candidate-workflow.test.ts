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

async function source() {
  expect(await Bun.file(workflowPath).exists()).toBeTrue()
  return Bun.file(workflowPath).text()
}

function parse(value: string) {
  return Bun.YAML.parse(value) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } }
    permissions: Record<string, string>
    jobs: Record<string, { needs?: string[]; permissions?: Record<string, string>; steps?: { uses?: string }[] }>
  }
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

  test("hostile authority, identity, mutability, and cohort regressions are observable", async () => {
    const value = await source()
    expect(authorityViolations(value.replace("contents: read", "contents: write"))).not.toEqual([])
    expect(authorityViolations(value.replace("overwrite: false", "overwrite: true"))).not.toEqual([])
    expect(authorityViolations(`${value}\n# npm publish\n`)).not.toEqual([])
    expect(authorityViolations(`${value}\n# BHARATCODE_ALLOW_UNSIGNED_WINDOWS=1\n`)).not.toEqual([])
    expect(value.replace("ref: ${{ inputs.source_sha }}", "ref: dev")).not.toContain("ref: ${{ inputs.source_sha }}")
    expect(value.replace(checkout, "actions/checkout@v7")).toContain("actions/checkout@v7")
    expect(value.replace("desktop-windows-x64", "desktop-windows-arm64")).not.toContain("desktop-windows-x64")
  })
})
