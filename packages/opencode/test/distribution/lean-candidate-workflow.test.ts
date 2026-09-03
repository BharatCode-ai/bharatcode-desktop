import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { parseCurrentBetaFixtureBytes } from "../../../desktop/scripts/lean-upgrade-receipt.mjs"
import { hostDistributionTarget } from "../../script/distribution.mjs"
import { canonicalLeanJson, PLATFORM_PACKAGE_NAMES, REQUIRED_COHORT_KEYS } from "../../script/lean-cohort.mjs"

const workflowPath = resolve(import.meta.dir, "../../../../.github/workflows/bharatcode-next-beta-candidate.yml")
const checkout = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const upload = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const download = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
const attest = "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6"
const reviewedSecurityEnclosureSha256 = {
  nativePreflight: "96c72efbac3d82b23c8aa3232608b63afea496818381c7aad4f3e922c896ab2d",
  linuxPackage: "32d6c30e4226645a9d9cce2bcfb6a7dd832a4604439c5dfb57d6715fb7c28783",
  windowsUnsigned: "5a357c93583798fd698b5fbab946ebcd058a6c6eee3391a2f58b5ab618fbca00",
} as const
const reviewedSecurityStepSha256 = {
  nativePreflight: "fb81af32a451e1fbb04c88c7b5cfc4e63eca4f759f73c3d967f17cd4001617d5",
  linuxPackage: "2b61f85cfa27650f30049e9d849a300d2d53a3420c11588a4964a75e16ea6278",
  windowsUnsigned: "a3c024ac9c6087fca041b9d2aeeab56f59e5086557e1dbb56169846d701f5c6d",
} as const
const acceptedApplicationSourceSha = "80c962f4148db531c35abcf4922059d2101c9bcd"
const acceptedReleaseParentSha = "51210073a4724ee6222b7c71c01d59f16b3a180e"
const wslRunnerLabel = "bharatcode-acceptance-${{ github.run_id }}-${{ github.run_attempt }}"
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
const currentBetaFixture = "packages/desktop/test/fixtures/current-beta-windows-x64.json"
const releaseReviewAuthority = "docs/superpowers/reports/2026-09-04-release-review-authority.md"
const canonicalAppRunGzip =
  "H4sIAAAAAAAAA61W72/aSBD9vn/FdOOrklOMIfclR+RTncMhlpIcAlfiFEXWYg94hVm7u0tCSvnfq/WPFIfeNZX6BezlzXtvZ3ZnOHrnzLhwZkylRKEGGwnhc7iHd2B/BmoN/MuPQwoPcAE6RUEAUDwSgBK7IXNOSHgdTFxqdSk5glTrou84SrN4mT+inGf5UyfOV86nNSrNc6GcP3p/ds975w5hcqHcY2p9oCfk7uPtpT+O/rmKvPHQsB3R2kfpwhuNBsG4ZeMIrrhIzBt4RTHgsgOBBq7KlYRLjHUun0GnTEOcC824UAY5XotOGR6mXAFTar1CE8Q0aLOiYskLDRIVT1ABF+Z7TwZyCQzUevaiUdEF81Y8VyDXoglnwkQHK7bA03IDDWG5ZJCarxAyvsTsGVKmgGUSWfJc5rnePgEomE5dah0nXAq2QqDWsYFlXCzBngO1tqYYO3pCTygBeEp5hnB/D9QykRTeuUApvH9vqov1qmP1KDw8XECSE4Baw9qar9+c33cEIMkFEoDKhVtzlaXHTZFLDSMvvHapta0Qu/7Lk7NW0lEzLvrW1oB2tAmZDobRwAu9aBCMJy7tOCplEp1+FVE+L0S+wmohy2OWfQfSt7Ytom/8N4PoJrgce+N/o1fuKkI+61vbV6D/dPcSS/e16YH4gXvn/+03csOJH4bB3XASTf6+9m9LuteOa9aMz+yzTtdRcYorpvrW9nvBO0rIZXDnNjfHmaVMMh3nCdoz1Oz15QpuvaEf+dMgjLyr0B9Hwd0k9G5uWjdOS1YA07jhGgy0PAFc+euMeXGMhcbE7RFSIY5PyJYAlCpWGwSuC7194gbWbgJg4yfotnEAuMEYqHUZ3JkDDoCZwsOfzE0w7eX+w8Ouws05KT92hKCUudz3Z2+gTLFphJ9RcP3cVj04SxRqmG2XZGDbGjfaqPZ2FM7+chJ8dMQ6y0y/zA5ElglnWb74oUqDs+2VWszyzZsFpm8UmL5RoM4xxmleQ6psmqRzDT2T1mdUIq/TGgbhje9aPfPoT0PXOvsVuW5miEk31xm61CqFaJ1/8+5Pw5Z9+PKl8tj9VaUopWFPutw4NNo/0Pv5yhzoxRkyeaDb68J595V6q2xVGk+bnZy+SKy4UlwsOjBZ8qLgYgH1GOnUV6whrK5PnGK8jBIs6loP/FFV6aajWMdPKY/T8s/DiJ60t1ofoYE/MiPyJ6UPe1arQTWL39peNe8N1xGIXJtBK4zKXOYreOI65WJ/Nl9AiiJGWBtTzYgerwXMcwn+BmO37HlfAZCxA8c0CQAA"
const canonicalAppRunSha256 = "897b7e36db7be71f3bf8a427cd24ece7d7fdd6763ecf79f9878e6e0a3f96b9d6"
const nativePayloads = {
  "@opentui/core-linux-arm64": [
    "libopentui.so",
    8313392,
    "33e1b1a7cceb0103a189161fe74606fc88034330201bd59049a88c86295b373a",
    "linux",
    "arm64",
  ],
  "@opentui/core-linux-x64": [
    "libopentui.so",
    8199928,
    "84f757983fe83bb47f4bc31bae73f5cafefbcd5bc891cf1b0aa8163dfbe6de2c",
    "linux",
    "x64",
  ],
  "@opentui/core-darwin-arm64": [
    "libopentui.dylib",
    1676080,
    "f5d966c54afd6969234b911460b8ce06085fbe287ce32a60554ff40b31c99a4f",
    "darwin",
    "arm64",
  ],
  "@opentui/core-darwin-x64": [
    "libopentui.dylib",
    1687295,
    "caa637b108a6c12d8a6287578f84de97c9db38df1500351ee8b19a40f4cd2968",
    "darwin",
    "x64",
  ],
  "@opentui/core-win32-arm64": [
    "opentui.dll",
    1662344,
    "20e901d69ead6c23181436592babfd000849ac15d84d592f9d9ed487d3e24eac",
    "win32",
    "arm64",
  ],
  "@opentui/core-win32-x64": [
    "opentui.dll",
    1851784,
    "3ddefc1a47f5f35aea1755b86f0d6f0f127b686a294a473c08234ae0b98e08cb",
    "win32",
    "x64",
  ],
  "@parcel/watcher-linux-arm64-glibc": [
    "watcher.node",
    457680,
    "a0bc8fc5f3e68e95218c2541b812dc07ba5fb8afd765b6252ab9e68ba5edb2aa",
    "linux",
    "arm64",
  ],
  "@parcel/watcher-linux-arm64-musl": [
    "watcher.node",
    469800,
    "21ffdef959a00016dca15757b31a2416db3bfcad21cd2ec93286b82c72b15c1e",
    "linux",
    "arm64",
  ],
  "@parcel/watcher-linux-x64-glibc": [
    "watcher.node",
    514960,
    "e58979069d4f71d2e36f7dc130d6dbc671e63666fe3943fd2ed481519cbf374c",
    "linux",
    "x64",
  ],
  "@parcel/watcher-linux-x64-musl": [
    "watcher.node",
    511160,
    "689df89fa2412de37604b44fe0223af61fa322f5cb12c3528a29cb2051b7fa1e",
    "linux",
    "x64",
  ],
  "@parcel/watcher-darwin-arm64": [
    "watcher.node",
    342608,
    "ea31618e251be57fdf7a8160bc2cb57d3131a430287681de2d321bbc3679e777",
    "darwin",
    "arm64",
  ],
  "@parcel/watcher-darwin-x64": [
    "watcher.node",
    346272,
    "5fc72d98675a3b98dd795ce8e533c8ee2ae73b850c541469dc5c0ba2ea42a2a1",
    "darwin",
    "x64",
  ],
  "@parcel/watcher-win32-arm64": [
    "watcher.node",
    548864,
    "805e3bdafc8b6f02b02955db024292652b0c92773a0918d1f78fdf2c8ff68769",
    "win32",
    "arm64",
  ],
  "@parcel/watcher-win32-x64": [
    "watcher.node",
    518144,
    "a8199cf7b6c5102267a5889f80321a4cc92e631d7504c474d32a35b4d440f315",
    "win32",
    "x64",
  ],
} as const
const opentuiNativeNames = Object.keys(nativePayloads).filter((name) => name.startsWith("@opentui/"))
const watcherNativeNames = Object.keys(nativePayloads).filter((name) => name.startsWith("@parcel/"))
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
  "beta.yml",
  "bharatcode-desktop-next-beta-win-x64.exe.blockmap",
  "beta-mac.yml",
  "bharatcode-desktop-next-beta-mac-arm64.zip.blockmap",
  "bharatcode-desktop-next-beta-mac-x64.zip.blockmap",
  "beta-linux.yml",
  "bharatcode-upgrade-rollback-windows-x64.json",
  "bharatcode-wsl-scenarios-9-10.json",
]
const internalWslInputs = [
  "manifest.json",
  "bharatcode-runtime-linux-x64-glibc",
  "bharatcode-wsl-runtime-manifest.json",
]
const releaseControlDeltaPaths = [
  ".github/workflows/bharatcode-next-beta-candidate.yml",
  "packages/desktop/scripts/lean-upgrade-acceptance.mjs",
  "packages/desktop/scripts/lean-upgrade-acceptance.test.ts",
  "packages/opencode/test/distribution/lean-candidate-workflow.test.ts",
  "packages/opencode/test/distribution/preliminary-unsigned-wsl-workflow.test.ts",
] as const

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
        if?: string
        needs?: string[]
        env?: Record<string, string>
        permissions?: Record<string, string>
        "runs-on"?: string | string[]
        steps?: {
          name?: string
          run?: string
          uses?: string
          if?: unknown
          shell?: string
          env?: Record<string, string>
          with?: Record<string, unknown>
        }[]
      }
    >
  }
}

function runStep(value: string, job: string, name: string) {
  return parse(value).jobs[job].steps?.find((step) => step.name === name)?.run ?? ""
}

function renderWslRunnerLabels(value: string, runId: string, runAttempt: string) {
  if (!/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error("test run identity is invalid")
  }
  const labels = parse(value).jobs["accept-wsl"]["runs-on"]
  if (!Array.isArray(labels)) throw new Error("WSL runner labels are not closed")
  return labels.map((label) =>
    label.replaceAll("${{ github.run_id }}", runId).replaceAll("${{ github.run_attempt }}", runAttempt),
  )
}

function wslRunnerBindingViolations(value: string) {
  const workflow = parse(value)
  const labels = workflow.jobs["accept-wsl"]["runs-on"]
  const labelList = Array.isArray(labels) ? labels : []
  const expected = ["self-hosted", "windows", "x64", "wsl2", wslRunnerLabel]
  const first = renderWslRunnerLabels(value, "29722640762", "1")
  const second = renderWslRunnerLabels(value, "29722640762", "2")
  const rendered = [first.at(-1), second.at(-1)]
  const wslSteps = workflow.jobs["accept-wsl"].steps ?? []
  const upload = wslSteps.find((step) => step.name === "Upload run-attempt-scoped WSL receipt")
  const validation = wslSteps.find((step) => step.name === "Validate exact WSL receipt binding")?.run ?? ""
  const assemble = workflow.jobs["assemble-cohort"]
  const download = assemble.steps?.find((step) => step.name === "Download every same-run producer artifact")
  const finalization = runStep(value, "assemble-cohort", "Rehash, close, and validate final manifest")
  return [
    ...(JSON.stringify(labels) === JSON.stringify(expected) ? [] : ["closed WSL runner labels"]),
    ...(rendered.every((label) => /^bharatcode-acceptance-[1-9][0-9]*-[1-9][0-9]*$/u.test(label ?? ""))
      ? []
      : ["WSL runner label grammar"]),
    ...(new Set(rendered).size === rendered.length ? [] : ["WSL runner label collision"]),
    ...(labelList.includes("bharatcode-acceptance") ? ["static WSL runner fallback"] : []),
    ...(labelList.some((label) => /inputs\.|vars\.|secrets\./u.test(label))
      ? ["operator-selected WSL runner label"]
      : []),
    ...(assemble.needs?.includes("accept-wsl") ? [] : ["assemble WSL dependency"]),
    ...(upload?.with?.name === "cp2-wsl-${{ github.run_id }}-${{ github.run_attempt }}"
      ? []
      : ["WSL upload run binding"]),
    ...(download?.with?.pattern === "cp2-*-${{ github.run_id }}-${{ github.run_attempt }}"
      ? []
      : ["assemble download run binding"]),
    ...(validation.includes("run_id: process.env.GITHUB_RUN_ID") &&
    validation.includes("run_attempt: process.env.GITHUB_RUN_ATTEMPT")
      ? []
      : ["WSL receipt run binding"]),
    ...(finalization.includes("run_id: process.env.GITHUB_RUN_ID") &&
    finalization.includes("run_attempt: process.env.GITHUB_RUN_ATTEMPT")
      ? []
      : ["cohort manifest run binding"]),
  ]
}

function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function closedSecurityStepViolations(value: string) {
  const workflow = parse(value)
  const specifications = [
    [
      "native preflight",
      "build-cli",
      "Preflight exact cross-platform native dependencies",
      "bash",
      reviewedSecurityStepSha256.nativePreflight,
    ],
    ["Linux package", "package-linux", "Build Linux packages", "bash", reviewedSecurityStepSha256.linuxPackage],
    [
      "Windows unsigned policy",
      "package-windows",
      "Verify unsigned Windows policy and package version",
      "pwsh",
      reviewedSecurityStepSha256.windowsUnsigned,
    ],
  ] as const
  return specifications.flatMap(([label, job, name, shell, expected]) => {
    const step = workflow.jobs[job].steps?.find((item) => item.name === name)
    if (!step) return [`${label} step missing`]
    return [
      ...(JSON.stringify(Object.keys(step).sort()) === JSON.stringify(["name", "run", "shell"])
        ? []
        : [`${label} step keys`]),
      ...(step.name === name ? [] : [`${label} step name`]),
      ...(step.shell === shell ? [] : [`${label} step shell`]),
      ...(sha256(canonicalJson(step)) === expected ? [] : [`${label} step digest`]),
    ]
  })
}

function securityEnclosureViolations(value: string) {
  const workflow = parse(value)
  const windows = workflow.jobs["package-windows"].steps ?? []
  const unsigned = windows.find((step) => step.name === "Verify unsigned Windows policy and package version")
  const digestEntries = [
    [
      "native preflight",
      runStep(value, "build-cli", "Preflight exact cross-platform native dependencies"),
      reviewedSecurityEnclosureSha256.nativePreflight,
    ],
    [
      "Linux package",
      runStep(value, "package-linux", "Build Linux packages"),
      reviewedSecurityEnclosureSha256.linuxPackage,
    ],
    ["Windows unsigned policy", unsigned?.run ?? "", reviewedSecurityEnclosureSha256.windowsUnsigned],
  ] as const
  return [
    ...closedSecurityStepViolations(value),
    ...digestEntries.flatMap(([name, run, expected]) => (sha256(run) === expected ? [] : [`${name} digest`])),
    ...(unsigned && !("if" in unsigned) ? [] : ["disabled Windows security step"]),
    ...(value.includes("AZURE_") || value.includes("azure/login@") || value.includes("sign-windows.ps1")
      ? ["obsolete Windows signing authority"]
      : []),
  ]
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

function bunEvalScripts(run: string) {
  return [...run.matchAll(/bun --eval '\n([\s\S]*?)\n\s*'/gu)].map((match) => match[1])
}

function runWorkflowDigestFixture(run: string) {
  const digest = run.match(
    /const digest = async \(path\) => createHash\("sha256"\)\.update\([^\n]+\)\.digest\("hex"\)/u,
  )?.[0]
  if (!digest) throw new Error("workflow digest implementation is missing")
  const root = mkdtempSync(resolve(process.env.TMPDIR ?? tmpdir(), "lean-workflow-digest-"))
  try {
    writeFileSync(resolve(root, "subject.bin"), "bharatcode-workflow-digest-fixture")
    return Bun.spawnSync(
      [
        "bun",
        "--eval",
        `import { createHash } from "node:crypto"\n${digest}\nprocess.stdout.write(await digest("subject.bin"))`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runWorkflowWaiverFixture(run: string) {
  const script = bunEvalScripts(run).find((value) => value.includes("validateLeanWslWaiver"))
  if (!script) throw new Error("workflow owner-waiver implementation is missing")
  const root = mkdtempSync(resolve(process.env.TMPDIR ?? tmpdir(), "lean-workflow-waiver-"))
  try {
    mkdirSync(resolve(root, "candidate-input"))
    writeFileSync(resolve(root, "candidate-input/bharatcode-desktop-next-beta-win-x64.exe"), "MZ-waiver-fixture")
    writeFileSync(resolve(root, "candidate-input/bharatcode-wsl-runtime-manifest.json"), '{"schema":1}\n')
    symlinkSync(resolve(import.meta.dir, "../../../../packages"), resolve(root, "packages"), "dir")
    const execution = Bun.spawnSync(["bun", "--eval", script], {
      cwd: root,
      env: {
        ...process.env,
        ACCEPTED_APPLICATION_SOURCE_SHA: "80c962f4148db531c35abcf4922059d2101c9bcd",
        GITHUB_ACTOR_VALUE: "release-fixture",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "123456789",
        SOURCE_SHA: "a".repeat(40),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const receiptPath = resolve(root, "bharatcode-wsl-acceptance-waiver.json")
    return {
      ...execution,
      receipt: execution.exitCode === 0 ? JSON.parse(readFileSync(receiptPath, "utf8")) : undefined,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runWorkflowCohortFixture(run: string, releaseStage?: string, updaterPrepare?: string) {
  const script = bunEvalScripts(run).find((value) => value.includes("validateLeanCohort"))
  if (!script) throw new Error("workflow cohort implementation is missing")
  const root = mkdtempSync(resolve(process.env.TMPDIR ?? tmpdir(), "lean-workflow-cohort-"))
  try {
    const packages = resolve(import.meta.dir, "../../../../packages")
    const input = resolve(root, "cohort-input")
    mkdirSync(input)
    symlinkSync(packages, resolve(root, "packages"), "dir")
    const cliVersion = JSON.parse(readFileSync(resolve(packages, "opencode/package.json"), "utf8")).version
    const desktopVersion = JSON.parse(readFileSync(resolve(packages, "desktop/package.json"), "utf8")).version
    const sourceSha = "a".repeat(40)
    const runId = "123456789"
    const runAttempt = "2"
    const writeSubject = (name: string, value = `subject:${name}`) => {
      const path = resolve(input, name)
      writeFileSync(path, value)
      writeFileSync(`${path}.intoto.jsonl`, `attestation:${name}`)
      return path
    }
    for (const name of ["bharatcode", ...PLATFORM_PACKAGE_NAMES]) writeSubject(`${name}-${cliVersion}.tgz`)
    const desktopSubjects = [
      "bharatcode-desktop-next-beta-linux-x64.AppImage",
      "bharatcode-desktop-next-beta-linux-x64.deb",
      "bharatcode-desktop-next-beta-mac-arm64.zip",
      "bharatcode-desktop-next-beta-mac-x64.zip",
    ]
    for (const name of desktopSubjects) writeSubject(name)
    const windowsName = "bharatcode-desktop-next-beta-win-x64.exe"
    const windowsPath = writeSubject(windowsName, "MZ-cohort-windows")
    const sha512 = (path: string) => new Bun.CryptoHasher("sha512").update(readFileSync(path)).digest("base64")
    const updaterInfo = (entries: Array<[string, string]>) => ({
      version: desktopVersion,
      files: entries.map(([sourceName, publicName]) => {
        const path = resolve(input, publicName)
        return { url: sourceName, sha512: sha512(path), size: readFileSync(path).byteLength }
      }),
      path: entries[0][0],
      sha512: sha512(resolve(input, entries[0][1])),
      releaseDate: "2026-09-01T09:59:00.000Z",
    })
    writeFileSync(
      resolve(input, "beta-windows.producer.yml"),
      Bun.YAML.stringify(updaterInfo([["bharatcode-desktop-win-x64.exe", windowsName]])),
    )
    writeFileSync(
      resolve(input, "beta-mac-arm64.producer.yml"),
      Bun.YAML.stringify(
        updaterInfo([["bharatcode-desktop-mac-arm64.zip", "bharatcode-desktop-next-beta-mac-arm64.zip"]]),
      ),
    )
    writeFileSync(
      resolve(input, "beta-mac-x64.producer.yml"),
      Bun.YAML.stringify(updaterInfo([["bharatcode-desktop-mac-x64.zip", "bharatcode-desktop-next-beta-mac-x64.zip"]])),
    )
    writeFileSync(
      resolve(input, "beta-linux.producer.yml"),
      Bun.YAML.stringify(
        updaterInfo([
          ["bharatcode-desktop-linux-x64.AppImage", "bharatcode-desktop-next-beta-linux-x64.AppImage"],
          ["bharatcode-desktop-linux-x64.deb", "bharatcode-desktop-next-beta-linux-x64.deb"],
        ]),
      ),
    )
    for (const name of [
      "bharatcode-desktop-next-beta-win-x64.exe.producer.blockmap",
      "bharatcode-desktop-next-beta-mac-arm64.zip.producer.blockmap",
      "bharatcode-desktop-next-beta-mac-x64.zip.producer.blockmap",
    ])
      writeFileSync(resolve(input, name), `blockmap:${name}`)
    if (!updaterPrepare) throw new Error("workflow updater preparation implementation is missing")
    const prepared = Bun.spawnSync(["bun", "--eval", updaterPrepare], {
      cwd: root,
      env: { ...process.env, DESKTOP_VERSION: desktopVersion },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (prepared.exitCode !== 0) throw new Error(`workflow updater preparation failed: ${prepared.stderr}`)
    for (const name of readdirSync(resolve(root, "updater-assets"))) {
      writeFileSync(resolve(root, "updater-assets", `${name}.intoto.jsonl`), `attestation:${name}`)
    }
    const runtimeManifestPath = resolve(input, "bharatcode-wsl-runtime-manifest.json")
    writeFileSync(runtimeManifestPath, '{"schema":1}\n')
    const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")
    const currentBeta = parseCurrentBetaFixtureBytes(
      new Uint8Array(readFileSync(resolve(packages, "desktop/test/fixtures/current-beta-windows-x64.json"))),
    )
    const candidate = {
      key: "desktop-windows-x64",
      filename: windowsName,
      bytes: readFileSync(windowsPath).byteLength,
      sha256: digest(windowsPath),
    }
    const checks = Object.fromEntries(
      [
        "bharatcode_runtime_only",
        "candidate_installed_over_beta",
        "candidate_started",
        "current_beta_download_verified",
        "current_beta_installed",
        "eligible_state_preserved",
        "eligible_state_seeded",
        "migration_source_preserved",
        "recovery_evidence_preserved",
        "rollback_installed",
        "rollback_state_structurally_valid",
        "share_network_attempt_absent",
        "sharenext_absent",
      ].map((key) => [key, true]),
    )
    const upgradeName = "bharatcode-upgrade-rollback-windows-x64.json"
    writeSubject(
      upgradeName,
      canonicalLeanJson({
        schema: "bharatcode-lean-upgrade-rollback-receipt-v1",
        result: "PASS",
        repository: currentBeta.repository,
        source_sha: sourceSha,
        candidate_tag: `next-beta-${sourceSha.slice(0, 12)}`,
        github: { run_id: runId, run_attempt: runAttempt },
        host: { os: "windows", arch: "x64", runner_image: "windows-2025" },
        current_beta: {
          release_id: currentBeta.release_id,
          tag: currentBeta.tag,
          source_sha: currentBeta.source_sha,
          asset: currentBeta.assets[0],
        },
        candidate,
        checks,
        completed_at: "2026-09-01T10:00:00.000Z",
      }),
    )
    const waiverName = "bharatcode-wsl-acceptance-waiver.json"
    writeSubject(
      waiverName,
      canonicalLeanJson({
        schema: "bharatcode-wsl-acceptance-waiver-v1",
        result: "OWNER_WAIVED",
        reason: "FORMAL_WINDOWS_WSL2_VM_ACCEPTANCE_NOT_RUN_BY_OWNER_DECISION",
        manual_acceptance: "INSTALLED_WINDOWS_STARTUP_SIGNIN_PROJECT_MODELS_SESSION_RESTORE_USER_CONFIRMED",
        accepted_application_source_sha: "80c962f4148db531c35abcf4922059d2101c9bcd",
        source_sha: sourceSha,
        desktop_sha256: candidate.sha256,
        runtime_manifest_sha256: digest(runtimeManifestPath),
        github: { actor: "release-fixture", run_id: Number(runId), run_attempt: Number(runAttempt) },
        completed_at: "2026-09-01T10:00:00.000Z",
      }),
    )
    const execution = Bun.spawnSync(["bun", "--eval", script], {
      cwd: root,
      env: {
        ...process.env,
        CLI_VERSION: cliVersion,
        DESKTOP_VERSION: desktopVersion,
        GITHUB_RUN_ATTEMPT: runAttempt,
        GITHUB_RUN_ID: runId,
        SOURCE_SHA: sourceSha,
        WORKFLOW_PATH: ".github/workflows/bharatcode-next-beta-candidate.yml",
        RELEASE_TAG: "desktop-beta-1.15.24",
        WSL_ACCEPTANCE_MODE: "owner-waived-hotfix-1.15.24",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    let releaseStageExitCode: number | undefined
    let releaseStageError: string | undefined
    let releaseAssets: string[] | undefined
    if (execution.exitCode === 0 && releaseStage) {
      symlinkSync(input, resolve(root, "release-input"), "dir")
      for (const filename of ["bharatcode-next-beta-cohort.json", "bharatcode-next-beta-cohort.json.sha256"]) {
        cpSync(resolve(root, filename), resolve(input, filename))
      }
      writeFileSync(resolve(input, "bharatcode-next-beta-cohort.json.intoto.jsonl"), "cohort-attestation")
      cpSync(resolve(root, "updater-assets"), resolve(input, "updater-assets"), { recursive: true })
      const staged = Bun.spawnSync(["bun", "--eval", releaseStage], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_RUN_ATTEMPT: runAttempt,
          GITHUB_RUN_ID: runId,
          RELEASE_TAG: "desktop-beta-1.15.24",
          SOURCE_SHA: sourceSha,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      releaseStageExitCode = staged.exitCode
      releaseStageError = staged.stderr.toString()
      releaseAssets = staged.exitCode === 0 ? readdirSync(resolve(root, "release-assets")).sort() : undefined
    }
    return {
      ...execution,
      manifest:
        execution.exitCode === 0
          ? JSON.parse(readFileSync(resolve(root, "bharatcode-next-beta-cohort.json"), "utf8"))
          : undefined,
      checksum:
        execution.exitCode === 0
          ? readFileSync(resolve(root, "bharatcode-next-beta-cohort.json.sha256"), "utf8")
          : undefined,
      releaseAssets,
      releaseStageError,
      releaseStageExitCode,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runWorkflowMetaPackageFixture(script: string) {
  const base = process.env.TMPDIR ?? tmpdir()
  const root = mkdtempSync(resolve(base, "lean-workflow-meta-"))
  const version = "0.0.0-run3-fixture.1"
  const violations: string[] = []
  try {
    for (const directory of ["packages/opencode/bin", "packages/opencode/script", "cli-dist", "out/cli"]) {
      mkdirSync(resolve(root, directory), { recursive: true })
    }
    for (const path of ["bin/bharatcode.mjs", "script/distribution.mjs", "script/lean-cohort.mjs"]) {
      cpSync(resolve(import.meta.dir, `../../${path}`), resolve(root, `packages/opencode/${path}`))
    }

    for (const name of PLATFORM_PACKAGE_NAMES) {
      const os = name.includes("windows") ? "win32" : name.includes("darwin") ? "darwin" : "linux"
      const arch = name.includes("arm64") ? "arm64" : "x64"
      const packageRoot = resolve(root, "cli-dist", name)
      const binary = resolve(packageRoot, "bin", `bharatcode${os === "win32" ? ".exe" : ""}`)
      mkdirSync(dirname(binary), { recursive: true })
      writeFileSync(
        resolve(packageRoot, "package.json"),
        JSON.stringify({ name, version, preferUnplugged: true, os: [os], cpu: [arch], files: ["bin"] }),
      )
      writeFileSync(binary, minimalNativeBytes(os, arch))
      chmodSync(binary, 0o755)
    }

    const host = hostDistributionTarget()
    if (process.platform !== "win32") {
      const hostPackage = host.candidates[0]
      const hostBinary = resolve(root, "cli-dist", hostPackage, "bin", host.binary)
      const compile = Bun.spawnSync(["cc", "-x", "c", "-o", hostBinary, "-"], {
        stdin: Buffer.from(`#include <stdio.h>\nint main(void) { puts("${version}"); return 0; }\n`),
        stdout: "pipe",
        stderr: "pipe",
      })
      if (compile.exitCode !== 0) throw new Error(`host fixture compilation failed: ${compile.stderr}`)
      chmodSync(hostBinary, 0o755)
    }

    const assembly = Bun.spawnSync(["bun", "--eval", script], {
      cwd: root,
      env: { ...Bun.env, CLI_VERSION: version },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (assembly.exitCode !== 0) {
      violations.push("workflow meta assembly")
      return violations
    }

    const metaName = `bharatcode-${version}.tgz`
    const metaPath = resolve(root, "out/cli", metaName)
    if (!readdirSync(resolve(root, "out/cli")).includes(metaName)) {
      violations.push("meta tarball missing")
      return violations
    }
    const tarList = Bun.spawnSync(["tar", "-tzf", metaPath], { stdout: "pipe", stderr: "pipe" })
    const entries = tarList.stdout.toString().trim().split("\n").filter(Boolean).sort()
    const expectedEntries = ["package/bin/bharatcode.mjs", "package/package.json", "package/script/distribution.mjs"]
    if (tarList.exitCode !== 0 || JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
      violations.push("closed meta tarball files")
    }

    const extract = (path: string) => Bun.spawnSync(["tar", "-xOf", metaPath, path], { stdout: "pipe", stderr: "pipe" })
    const launcher = extract("package/bin/bharatcode.mjs")
    const distribution = extract("package/script/distribution.mjs")
    const manifest = extract("package/package.json")
    const sourceLauncher = new Uint8Array(
      await Bun.file(resolve(root, "packages/opencode/bin/bharatcode.mjs")).arrayBuffer(),
    )
    const sourceDistribution = new Uint8Array(
      await Bun.file(resolve(root, "packages/opencode/script/distribution.mjs")).arrayBuffer(),
    )
    if (launcher.exitCode !== 0 || sha256(launcher.stdout) !== sha256(sourceLauncher)) {
      violations.push("launcher source bytes")
    }
    if (distribution.exitCode !== 0 || sha256(distribution.stdout) !== sha256(sourceDistribution)) {
      violations.push("distribution source bytes")
    }
    if (manifest.exitCode !== 0) {
      violations.push("meta manifest missing")
    } else {
      const parsed = JSON.parse(manifest.stdout.toString())
      const expected = {
        name: "bharatcode",
        version,
        type: "module",
        bin: { bharatcode: "bin/bharatcode.mjs" },
        files: ["bin", "script/distribution.mjs"],
        optionalDependencies: Object.fromEntries(PLATFORM_PACKAGE_NAMES.map((name) => [name, version])),
        os: ["darwin", "linux", "win32"],
        cpu: ["arm64", "x64"],
      }
      if (canonicalJson(parsed) !== canonicalJson(expected)) violations.push("closed meta manifest")
    }

    if (process.platform !== "win32") {
      const hostTarball = resolve(root, "out/cli", `${host.candidates[0]}-${version}.tgz`)
      const prefix = resolve(root, "global")
      const install = Bun.spawnSync(
        [
          "npm",
          "install",
          "--global",
          "--prefix",
          prefix,
          "--ignore-scripts",
          "--omit=optional",
          "--offline",
          hostTarball,
          metaPath,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      )
      if (install.exitCode !== 0) {
        violations.push(`offline host install: ${install.stderr.toString().trim()}`)
      } else {
        const consumer = resolve(root, "consumer")
        const npxCache = resolve(prefix, ".npx-cache")
        mkdirSync(consumer)
        mkdirSync(npxCache)
        const env = {
          ...Bun.env,
          PATH: `${resolve(prefix, "bin")}:${Bun.env.PATH ?? ""}`,
          npm_config_cache: npxCache,
          npm_config_offline: "true",
          npm_config_prefix: prefix,
        }
        const direct = Bun.spawnSync([resolve(prefix, "bin", "bharatcode"), "--version"], {
          cwd: consumer,
          env,
          stdout: "pipe",
          stderr: "pipe",
        })
        const npx = Bun.spawnSync(["npx", "--no-install", "bharatcode", "--version"], {
          cwd: consumer,
          env,
          stdout: "pipe",
          stderr: "pipe",
        })
        if (direct.exitCode !== 0 || direct.stdout.toString().trim() !== version) {
          violations.push("global bharatcode execution")
        }
        if (npx.exitCode !== 0 || npx.stdout.toString().trim() !== version) {
          violations.push("npx --no-install execution")
        }
      }
    }
    return violations
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runWindowsGlobalAcceptanceFixture(run: string) {
  const base = process.env.TMPDIR ?? tmpdir()
  const root = mkdtempSync(resolve(base, "lean-windows-global-"))
  const version = "0.0.0-run4-fixture.1"
  try {
    const prefix = resolve(root, "windows-prefix")
    const shadowPrefix = resolve(root, String.raw`\a\_temp`, "bharatcode-cli-native")
    const tools = resolve(root, "tools")
    const launcher = resolve(prefix, "node_modules/bharatcode/bin/bharatcode.mjs")
    const distribution = resolve(prefix, "node_modules/bharatcode/script/distribution.mjs")
    const native = resolve(prefix, "node_modules/bharatcode-windows-x64/bin/bharatcode.exe")
    for (const path of [dirname(launcher), dirname(distribution), dirname(native), shadowPrefix, tools]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(launcher, '#!/usr/bin/env bash\n[[ "${1:-}" == "--version" ]]\nprintf "%s\\n" "$CLI_VERSION"\n')
    writeFileSync(distribution, "export const fixture = true\n")
    writeFileSync(native, "fixture Windows x64 binary\n")
    chmodSync(launcher, 0o755)

    const shim = `#!/usr/bin/env bash
set -euo pipefail
basedir=$(dirname "$(printf '%s\\n' "$0" | sed -e 's,\\\\,/,g')")
basedir=$(cygpath -w "$basedir")
target="$basedir/node_modules/bharatcode/bin/bharatcode.mjs"
if [[ ! -f "$target" ]]; then
  printf "Error: Cannot find module '%s'\\n" "$target" >&2
  exit 1
fi
exec "$target" "$@"
`
    writeFileSync(resolve(prefix, "bharatcode"), shim)
    writeFileSync(resolve(prefix, "bharatcode.cmd"), "fixture cmd shim\n")
    writeFileSync(resolve(prefix, "bharatcode.ps1"), "fixture PowerShell shim\n")
    cpSync(resolve(prefix, "bharatcode"), resolve(shadowPrefix, "bharatcode"))
    chmodSync(resolve(prefix, "bharatcode"), 0o755)
    chmodSync(resolve(shadowPrefix, "bharatcode"), 0o755)

    writeFileSync(
      resolve(tools, "cygpath"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-u" ]]; then
  [[ "$2" == 'D:\\a\\_temp/bharatcode-cli-native' ]]
  printf '%s\\n' "$WINDOWS_PREFIX_ROOT"
  exit 0
fi
[[ "$1" == "-w" ]]
if [[ "$2" == /a/_temp/* ]]; then
  value="${"$"}{2#/a}"
  printf 'A:%s\\n' "${"$"}{value//\//\\\\}"
  exit 0
fi
printf '%s\\n' "$2"
`,
    )
    writeFileSync(
      resolve(tools, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ " $* " == *" --global "* ]]
[[ " $* " == *" --prefix D:\\a\\_temp/bharatcode-cli-native "* ]]
[[ " $* " == *" --ignore-scripts "* && " $* " == *" --offline "* ]]
printf 'added 2 packages\\n'
`,
    )
    writeFileSync(
      resolve(tools, "npx"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$npm_config_prefix" == 'D:\\a\\_temp/bharatcode-cli-native' ]]
[[ "$npm_config_offline" == "true" ]]
[[ "$npm_config_cache" == "$WINDOWS_PREFIX_ROOT/.npx-cache" ]]
[[ -d "$npm_config_cache" && -z "$(find "$npm_config_cache" -mindepth 1 -print -quit)" ]]
[[ "$#" -eq 3 && "$1" == "--no-install" && "$2" == "bharatcode" && "$3" == "--version" ]]
exec bharatcode --version
`,
    )
    for (const name of ["cygpath", "npm", "npx"]) chmodSync(resolve(tools, name), 0o755)

    mkdirSync(resolve(root, "candidate-input"))
    writeFileSync(resolve(root, `candidate-input/bharatcode-${version}.tgz`), "fixture meta tarball\n")
    writeFileSync(resolve(root, `candidate-input/bharatcode-windows-x64-${version}.tgz`), "fixture native tarball\n")
    return Bun.spawnSync(["bash", "-c", run.replaceAll("${{ matrix.package }}", "bharatcode-windows-x64")], {
      cwd: root,
      env: {
        ...Bun.env,
        CLI_VERSION: version,
        PATH: `${tools}:${Bun.env.PATH ?? ""}`,
        RUNNER_OS: "Windows",
        RUNNER_TEMP: String.raw`D:\a\_temp`,
        WINDOWS_PREFIX_ROOT: prefix,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function minimalNativeBytes(os: string, arch: string) {
  const bytes = Buffer.alloc(os === "win32" ? 128 : 64)
  if (os === "linux") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01])
    bytes.writeUInt16LE(0x02, 16)
    bytes.writeUInt16LE(arch === "arm64" ? 0xb7 : 0x3e, 18)
    bytes.writeUInt32LE(0x01, 20)
  } else if (os === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4)
  } else {
    bytes.set([0x4d, 0x5a])
    bytes.writeUInt32LE(0x40, 0x3c)
    bytes.writeUInt32LE(0x00004550, 0x40)
    bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 0x44)
  }
  return bytes
}

type NativeFixtureMode = "valid" | "digest" | "entry-symlink" | "payload-symlink" | "package-origin" | "magic" | "arch"

function runNativePreflightFixture(script: string, mode: NativeFixtureMode) {
  const base = process.env.TMPDIR ?? tmpdir()
  const root = mkdtempSync(resolve(base, "lean-native-preflight-"))
  try {
    const packageRoot = resolve(root, "packages/opencode")
    const modules = resolve(root, "node_modules")
    const version = "1.2.3"
    const fixtures = [
      ["@fixture/elf-arm64", "native.bin", "linux", "arm64"],
      ["@fixture/elf-x64", "native.bin", "linux", "x64"],
      ["@fixture/macho-arm64", "native.bin", "darwin", "arm64"],
      ["@fixture/macho-x64", "native.bin", "darwin", "x64"],
      ["@fixture/pe-arm64", "native.bin", "win32", "arm64"],
      ["@fixture/pe-x64", "native.bin", "win32", "x64"],
    ] as const
    const metadata: Record<string, { file: string; bytes: number; sha256: string; os: string; arch: string }> = {}
    mkdirSync(packageRoot, { recursive: true })
    for (const [name, file, os, arch] of fixtures) {
      const packageDir = resolve(modules, name)
      const targetMode = name === "@fixture/elf-arm64" ? mode : "valid"
      const bytes = minimalNativeBytes(os, targetMode === "arch" ? "x64" : arch)
      if (targetMode === "magic") bytes[0] = 0
      const materializedPackageDir = targetMode === "package-origin" ? resolve(root, "outside-package") : packageDir
      mkdirSync(materializedPackageDir, { recursive: true })
      if (targetMode === "package-origin") {
        mkdirSync(dirname(packageDir), { recursive: true })
        symlinkSync(materializedPackageDir, packageDir)
      }
      const entry = resolve(materializedPackageDir, "index.js")
      const payload = resolve(materializedPackageDir, file)
      if (targetMode === "entry-symlink") {
        const outside = resolve(root, "outside-entry.js")
        writeFileSync(outside, "export {}\n")
        symlinkSync(outside, entry)
      } else writeFileSync(entry, "export {}\n")
      if (targetMode === "payload-symlink") {
        const outside = resolve(root, "outside-native.bin")
        writeFileSync(outside, bytes)
        symlinkSync(outside, payload)
      } else writeFileSync(payload, bytes)
      writeFileSync(
        resolve(materializedPackageDir, "package.json"),
        JSON.stringify({ name, version, main: "index.js" }),
      )
      metadata[name] = {
        file,
        bytes: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        os,
        arch,
      }
      if (targetMode === "digest") writeFileSync(payload, Buffer.concat([bytes, Buffer.from([0])]))
    }
    const validationStart = script.indexOf("const payloads = {")
    if (validationStart < 0) throw new Error("native validation boundary missing")
    const validation = script.slice(validationStart)
    let fixtureScript = validation.replace(
      /const payloads = \{[\s\S]*?\n\s*\}\n\s*const required =/u,
      `const payloads = ${JSON.stringify(metadata)}\n            const required =`,
    )
    if (fixtureScript === validation || !fixtureScript.includes("const required =")) {
      throw new Error("native fixture rewrite failed")
    }
    fixtureScript = `
      import { realpathSync } from "node:fs"
      import { dirname, resolve, sep } from "node:path"
      const packageRoot = resolve("packages/opencode")
      const approvedDependencyRoot = realpathSync(resolve("node_modules"))
      const opentui = ${JSON.stringify(fixtures.map(([name]) => name))}
      const watcher = []
      const versions = { opentui: "${version}", watcher: "${version}" }
      ${fixtureScript}
    `
    return Bun.spawnSync(["bun", "--eval", fixtureScript], { cwd: root, stdout: "pipe", stderr: "pipe" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function nativePreflightExecutionViolations(script: string) {
  const violations: string[] = []
  const validationStart = script.indexOf("const payloads = {")
  if (validationStart < 0 || /process\.exit|if\s*\(\s*false\s*\)/u.test(script.slice(0, validationStart))) {
    violations.push("enclosing reachability")
  }
  if (runNativePreflightFixture(script, "valid").exitCode !== 0) violations.push("valid")
  for (const mode of ["digest", "entry-symlink", "payload-symlink", "package-origin", "magic", "arch"] as const) {
    if (runNativePreflightFixture(script, mode).exitCode === 0) violations.push(mode)
  }
  return violations
}

type AppRunFixtureMode = "valid" | "wrapper" | "missing" | "invalid" | "symlink" | "non-executable" | "wrong-arch"

function appRunVerificationScript(run: string) {
  const lines = run.split("\n")
  const first = "bash -n squashfs-root/AppRun"
  const last = "file -L -b \"$appimage_target\" | grep -E '^ELF 64-bit LSB (pie )?executable, x86-64,'"
  const start = lines.findIndex((line) => line.trim() === first)
  const end = lines.findIndex((line, index) => index >= start && line.trim() === last)
  if (start < 0 || end < 0) throw new Error("AppRun verification boundary missing")
  return lines.slice(start, end + 1).join("\n")
}

function runAppRunFixture(script: string, mode: AppRunFixtureMode) {
  const base = process.env.TMPDIR ?? tmpdir()
  const root = mkdtempSync(resolve(base, "lean-apprun-"))
  try {
    const squashfs = resolve(root, "squashfs-root")
    const target = resolve(squashfs, "bharatcode-beta")
    mkdirSync(squashfs)
    const canonical = Bun.gunzipSync(Buffer.from(canonicalAppRunGzip, "base64"))
    writeFileSync(
      resolve(squashfs, "AppRun"),
      mode === "wrapper" ? Buffer.concat([canonical, Buffer.from("\nexec alternate\n")]) : canonical,
    )
    chmodSync(resolve(squashfs, "AppRun"), 0o755)
    if (mode !== "missing") {
      const bytes =
        mode === "invalid"
          ? Buffer.from("#!/bin/sh\nexit 0\n")
          : minimalNativeBytes("linux", mode === "wrong-arch" ? "arm64" : "x64")
      const actual = mode === "symlink" ? resolve(root, "outside-target") : target
      writeFileSync(actual, bytes)
      chmodSync(actual, mode === "non-executable" ? 0o644 : 0o755)
      if (mode === "symlink") symlinkSync(actual, target)
    }
    return Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], {
      cwd: root,
      env: { ...Bun.env, expected_package: "bharatcode-beta" },
      stdout: "pipe",
      stderr: "pipe",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function appRunExecutionViolations(script: string) {
  const violations: string[] = []
  if (runAppRunFixture(script, "valid").exitCode !== 0) violations.push("valid")
  for (const mode of ["wrapper", "missing", "invalid", "symlink", "non-executable", "wrong-arch"] as const) {
    if (runAppRunFixture(script, mode).exitCode === 0) violations.push(mode)
  }
  return violations
}

function appRunStepExecutionViolations(run: string, disabled = false) {
  const validation = appRunVerificationScript(run)
  const prefix = run.slice(0, run.indexOf(validation))
  return [
    ...(disabled ? ["disabled step"] : []),
    ...(/(?:^|\n)\s*(?:exit|return)(?:\s+0)?\s*(?:\n|$)|(?:^|\n)\s*if\s+false\s*;/u.test(prefix)
      ? ["enclosing reachability"]
      : []),
    ...appRunExecutionViolations(validation),
  ]
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
    'candidate: { key: "desktop-windows-x64", filename: windows.filename, bytes: windows.bytes, sha256: windows.sha256 }',
  ]
  return [
    ...required.filter((fragment) => !run.includes(fragment)),
    ...(run.indexOf("parseLeanUpgradeReceiptBytes(") < run.indexOf("const manifest =") ? [] : ["validation order"]),
  ]
}

function authorityViolations(value: string) {
  const workflow = parse(value)
  const permissions = [
    ["workflow", workflow.permissions] as const,
    ...Object.entries(workflow.jobs).flatMap(([name, job]) =>
      job.permissions ? ([[name, job.permissions]] as const) : [],
    ),
  ]
  const forbidden = [
    /npm\s+publish/iu,
    /homebrew.*(?:push|update)/iu,
    /(?:updater|channel).*(?:promote|publish)/iu,
    /--clobber/iu,
    /(?:@|:)latest\b/iu,
    /npm\s+(?:dist-tag|tag).*\bnext\b/iu,
    /BHARATCODE_ALLOW_UNSIGNED_MAC/u,
  ]
  return [
    ...permissions.flatMap(([job, item]) =>
      Object.entries(item).flatMap(([name, access]) =>
        (name === "contents" && access === "read") ||
        (job === "publish-release" && name === "contents" && access === "write") ||
        (name === "id-token" && access === "write") ||
        (name === "attestations" && access === "write")
          ? []
          : [`${job}:${name}:${access}`],
      ),
    ),
    ...forbidden.flatMap((pattern) => (pattern.test(value) ? [pattern.source] : [])),
    ...(value.includes("overwrite: false") ? [] : ["overwrite"]),
  ]
}

function nativeBuildViolations(value: string) {
  const steps = parse(value).jobs["build-cli"].steps ?? []
  const install = steps.findIndex((step) => step.name === "Install exact dependencies")
  const preflight = steps.findIndex((step) => step.name === "Preflight exact cross-platform native dependencies")
  const clean = steps.findIndex((step) => step.name === "Prove dependency install kept exact build inputs clean")
  const build = steps.findIndex((step) => step.name === "Build and pack the exact CLI cohort and Desktop WSL runtime")
  const installRun = steps[install]?.run ?? ""
  const preflightRun = steps[preflight]?.run ?? ""
  const cleanRun = steps[clean]?.run ?? ""
  const buildRun = steps[build]?.run ?? ""
  const requiredPreflight = [
    'from "./packages/opencode/script/distribution.mjs"',
    "PLATFORM_TARGETS.map",
    "`@opentui/core-${target.os}-${target.arch}`",
    '`@parcel/watcher-${target.os}-${target.arch}${target.os === "linux" ? `-${target.abi ?? "glibc"}` : ""}`',
    'root.workspaces.catalog["@opentui/core"]',
    'opencode.dependencies["@parcel/watcher"]',
    "!/^\\d+\\.\\d+\\.\\d+$/.test(versions.opentui) || !/^\\d+\\.\\d+\\.\\d+$/.test(versions.watcher)",
    'const opentuiManifestResolution = Bun.resolveSync("@opentui/core/package.json", packageRoot)',
    "const opentuiManifestPath = realpathSync(opentuiManifestResolution)",
    "const opentuiManifest = await Bun.file(opentuiManifestPath).json()",
    "opentuiManifest.optionalDependencies[name] !== versions.opentui",
    "opencode.devDependencies[name] !== versions.watcher",
    "Bun.resolveSync(`${name}/package.json`, packageRoot)",
    "Bun.resolveSync(name, packageRoot)",
    "manifest.name !== name || manifest.version !== version",
    "const packageDir = realpathSync(dirname(manifestPath))",
    "entry !== packageDir && !entry.startsWith(`${packageDir}${sep}`)",
    "const payloadResolution = resolve(packageDir, payload.file)",
    "const payloadPath = realpathSync(payloadResolution)",
    "!payloadPath.startsWith(`${packageDir}${sep}`)",
    "payload.bytes !== bytes.length",
    'new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== payload.sha256',
    'Buffer.from(bytes.subarray(0, 6)).toString("hex") !== "7f454c460201"',
    'payload.arch === "arm64" ? 0xb7 : 0x3e',
    "view.getUint32(0, true) !== 0xfeedfacf",
    'payload.arch === "arm64" ? 0x0100000c : 0x01000007',
    "bytes[0] !== 0x4d || bytes[1] !== 0x5a",
    "const peOffset = bytes.length >= 0x40 ? view.getUint32(0x3c, true) : bytes.length",
    "peOffset + 6 > bytes.length",
    "view.getUint32(peOffset, true) !== 0x00004550",
    'payload.arch === "arm64" ? 0xaa64 : 0x8664',
    "view.getUint16(18, true)",
    "view.getUint32(4, true)",
    "view.getUint32(0x3c, true)",
    "view.getUint16(peOffset + 4, true)",
    "opentui.length !== 6 || watcher.length !== 8",
    'const approvedDependencyRoot = realpathSync(resolve(workspaceRoot, "node_modules"))',
    'approvedDependencyRoot !== resolve(workspaceRoot, "node_modules")',
    "manifestResolution !== manifestPath",
    "!manifestPath.startsWith(`${approvedDependencyRoot}${sep}`)",
    "entryResolution !== entry",
    "payloadResolution !== payloadPath",
  ]
  return [
    ...(installRun === "bun install --frozen-lockfile --linker hoisted --os='*' --cpu='*'" ? [] : ["install"]),
    ...requiredPreflight.filter((fragment) => !preflightRun.includes(fragment)),
    ...Object.entries(nativePayloads).filter(
      ([name, [file, bytes, sha256, os, arch]]) =>
        !preflightRun.includes(
          `"${name}": { file: "${file}", bytes: ${bytes}, sha256: "${sha256}", os: "${os}", arch: "${arch}" }`,
        ),
    ),
    ...(cleanRun.includes("git status --porcelain=v1 -- package.json bun.lock packages/opencode/package.json")
      ? []
      : ["clean inputs"]),
    ...(buildRun.match(/script\/build\.ts[^\n]*--skip-install/gu)?.length === 2 ? [] : ["skip-install builds"]),
    ...(install >= 0 && install < preflight && preflight < clean && clean < build ? [] : ["ordering"]),
    ...(steps[preflight]?.if === undefined ? [] : ["disabled preflight"]),
    ...(preflightRun.startsWith("set -euo pipefail\nbun --eval '\n") ? [] : ["preflight enclosure"]),
  ]
}

function metaPackageBuildViolations(run: string) {
  const required = [
    'import { lstatSync, realpathSync } from "node:fs"',
    'import { resolve, sep } from "node:path"',
    "await Bun.$`mkdir -p ${metaRoot}/bin ${metaRoot}/script`",
    "realpathSync(metaRoot) !== metaRoot || lstatSync(metaRoot).isSymbolicLink()",
    '{ source: resolve("packages/opencode/bin/bharatcode.mjs"), target: resolve(metaRoot, "bin/bharatcode.mjs"), packagePath: "package/bin/bharatcode.mjs" }',
    '{ source: resolve("packages/opencode/script/distribution.mjs"), target: resolve(metaRoot, "script/distribution.mjs"), packagePath: "package/script/distribution.mjs" }',
    "realpathSync(binding.source) !== binding.source || lstatSync(binding.source).isSymbolicLink()",
    "!binding.target.startsWith(`${metaRoot}${sep}`)",
    "realpathSync(binding.target) !== binding.target || lstatSync(binding.target).isSymbolicLink()",
    "sourceBytes.length !== targetBytes.length || digest(sourceBytes) !== digest(targetBytes)",
    'type: "module"',
    'files: ["bin", "script/distribution.mjs"]',
    'JSON.stringify(Object.keys(writtenManifest).sort()) !== JSON.stringify(["bin", "cpu", "files", "name", "optionalDependencies", "os", "type", "version"])',
    "JSON.stringify(writtenManifest) !== JSON.stringify(metaManifest)",
    'const expectedEntries = ["package/bin/bharatcode.mjs", "package/package.json", "package/script/distribution.mjs"]',
    "sourceBytes.length !== extracted.stdout.length || digest(sourceBytes) !== digest(extracted.stdout)",
    "manifestBytes.length !== extractedManifest.stdout.length || digest(manifestBytes) !== digest(extractedManifest.stdout)",
  ]
  return required.filter((fragment) => !run.includes(fragment))
}

function nativeAcceptanceLayoutViolations(run: string) {
  const required = [
    "Run 29722640762 job 88289107783",
    "printf '%s\\n' \"native CLI acceptance layout validation failed\" >&2",
    'if [[ "$RUNNER_OS" == "Windows" ]]',
    'prefix_path="$(cygpath -u "$prefix")"',
    'package_root="$prefix_path/node_modules/bharatcode"',
    'native_root="$prefix_path/node_modules/${{ matrix.package }}"',
    'shim_root="$prefix_path"',
    'package_root="$prefix/lib/node_modules/bharatcode"',
    'native_root="$prefix/lib/node_modules/${{ matrix.package }}"',
    'shim_root="$prefix/bin"',
    '[[ -f "$package_root/bin/bharatcode.mjs" ]]',
    '[[ -f "$package_root/script/distribution.mjs" ]]',
    '[[ -f "$native_root/bin/bharatcode${windows_suffix}" ]]',
    '[[ -f "$shim_root/bharatcode" ]]',
    '[[ "$RUNNER_OS" != "Windows" || -f "$shim_root/bharatcode.cmd" ]]',
    '[[ "$RUNNER_OS" != "Windows" || -f "$shim_root/bharatcode.ps1" ]]',
    "grep -F 'node_modules/bharatcode/bin/bharatcode.mjs' \"$shim_root/bharatcode\"",
    'export PATH="$shim_root:$PATH"',
    '[[ "$(command -v bharatcode)" == "$shim_root/bharatcode" ]]',
    'export npm_config_prefix="$prefix"',
    "export npm_config_offline=true",
    'npx_cache="$prefix_path/.npx-cache"',
    '[[ ! -e "$npx_cache" ]] || fail_layout',
    'mkdir "$npx_cache"',
    'export npm_config_cache="$npx_cache"',
    "printf '%s\\n' \"native CLI layout verified: $layout\"",
  ]
  const install = run.indexOf("npm install --global")
  const layout = run.indexOf('if [[ "$RUNNER_OS" == "Windows" ]]')
  const path = run.indexOf('export PATH="$shim_root:$PATH"')
  const cache = run.indexOf('export npm_config_cache="$npx_cache"')
  const diagnostic = run.indexOf("native CLI layout verified: $layout")
  const direct = run.indexOf('[[ "$(bharatcode --version)" == "$CLI_VERSION" ]]')
  const npx = run.indexOf("npx --no-install bharatcode --version")
  return [
    ...required.filter((fragment) => !run.includes(fragment)),
    ...(run.includes('export PATH="$prefix/bin:$prefix:$PATH"') ? ["raw Windows prefix in PATH"] : []),
    ...(install >= 0 &&
    install < layout &&
    layout < path &&
    path < cache &&
    cache < diagnostic &&
    diagnostic < direct &&
    direct < npx
      ? []
      : ["acceptance ordering"]),
  ]
}

function runOnePackagingViolations(value: string) {
  const linux = runStep(value, "package-linux", "Build Linux packages")
  const macos = runStep(value, "package-macos", "Build signed, notarized, stapled macOS package")
  const requiredLinux = [
    "Run 29712784688 job 88259572297",
    "app-builder-bin v5.0.0-alpha.12 source 580c34f2e19347061bc2243fa6ab6e57e9bbd2a6",
    "bash -n squashfs-root/AppRun",
    '[[ "$(stat -c %s squashfs-root/AppRun)" -eq 2356 ]]',
    `[[ "$(sha256sum squashfs-root/AppRun | cut -d ' ' -f 1)" == "${canonicalAppRunSha256}" ]]`,
    'appimage_target="squashfs-root/$expected_package"',
    '[[ -f "$appimage_target" && -x "$appimage_target" && ! -L "$appimage_target" ]]',
    "file -L -b \"$appimage_target\" | grep -E '^ELF 64-bit LSB (pie )?executable, x86-64,'",
  ]
  const requiredMacos = [
    "Run 29712784688 jobs 88259572335 and 88259572313",
    "EXPECTED_APPLE_DEVELOPER_ID_SUBJECT: ${{ vars.BHARATCODE_EXPECTED_APPLE_DEVELOPER_ID_SUBJECT }}",
    "const value = process.env.EXPECTED_APPLE_DEVELOPER_ID_SUBJECT",
    "/^[A-Za-z0-9][A-Za-z0-9 .-]{0,127}$/.test(value)",
    "const team = process.env.APPLE_TEAM_ID",
    "!/^[A-Z0-9]{10}$/.test(team)",
    'expected_authority="Developer ID Application: ${EXPECTED_APPLE_DEVELOPER_ID_SUBJECT} (${APPLE_TEAM_ID})"',
    '[[ "$(grep -c \'^Authority=\' <<< "$signature")" -eq 3 ]]',
    'grep -Fx "Authority=$expected_authority" <<< "$signature"',
    'grep -Fx "Authority=Developer ID Certification Authority" <<< "$signature"',
    'grep -Fx "Authority=Apple Root CA" <<< "$signature"',
    '[[ "$(grep -c \'^TeamIdentifier=\' <<< "$signature")" -eq 1 ]]',
    'grep -Fx "TeamIdentifier=$APPLE_TEAM_ID" <<< "$signature"',
  ]
  return [
    ...requiredLinux.filter((fragment) => !value.includes(fragment) && !linux.includes(fragment)),
    ...requiredMacos.filter((fragment) => !value.includes(fragment) && !macos.includes(fragment)),
    ...(value.includes("vars.BHARATCODE_APPLE_DEVELOPER_ID_APPLICATION") ? ["obsolete repository variable"] : []),
    ...(value.includes('EXPECTED_APPLE_DEVELOPER_ID_SUBJECT: "Shrey Gupta"') ? ["hardcoded subject"] : []),
    ...(linux.includes("file squashfs-root/AppRun") ? ["wrapper file type"] : []),
    ...(linux.includes("grep -c '^[[:space:]]*BIN='") ? ["line-presence wrapper validation"] : []),
  ]
}

function windowsUnsignedPolicyViolations(value: string) {
  const job = parse(value).jobs["package-windows"]
  const steps = job.steps ?? []
  const toolchain = steps.findIndex((step) => step.name === "Require Windows native build tools")
  const download = steps.findIndex((step) => step.name === "Download same-run WSL runtime")
  const install = steps.findIndex((step) => step.name === "Install exact dependencies and stage WSL runtime")
  const build = steps.findIndex((step) => step.name === "Build unsigned Windows installer")
  const verify = steps.findIndex((step) => step.name === "Verify unsigned Windows policy and package version")
  const attest = steps.findIndex((step) => step.name === "Attest Windows installer")
  const installRun = steps[install]?.run ?? ""
  const verifyRun = steps[verify]?.run ?? ""
  const runtimeReadOnly = "Set-ItemProperty -LiteralPath $runtime -Name IsReadOnly -Value $true"
  const manifestReadOnly = "Set-ItemProperty -LiteralPath $manifest -Name IsReadOnly -Value $true"
  const stageRuntime = "bun run --cwd packages/desktop stage:wsl-runtime"
  const requiredVerification = [
    '$env:BHARATCODE_ALLOW_UNSIGNED_WINDOWS -cne "1"',
    '$env:CSC_IDENTITY_AUTO_DISCOVERY -cne "false"',
    '$signature.Status -ne "NotSigned"',
    "$null -ne $signature.SignerCertificate",
    "$null -ne $signature.TimeStamperCertificate",
    "Windows package unexpectedly contains a signature",
    "Windows package version drift",
  ]
  return [
    ...(job["runs-on"] === "windows-2022" ? [] : ["native build runner"]),
    ...(toolchain >= 0 && toolchain < download ? [] : ["native build toolchain ordering"]),
    ...(steps[toolchain]?.run?.includes("Microsoft.VisualStudio.Component.VC.Tools.x86.x64")
      ? []
      : ["native build toolchain preflight"]),
    ...(job.permissions?.["id-token"] === "write" ? [] : ["id-token"]),
    ...(job.env?.BHARATCODE_ALLOW_UNSIGNED_WINDOWS === "1" ? [] : ["unsigned opt-in"]),
    ...(job.env?.CSC_IDENTITY_AUTO_DISCOVERY === "false" ? [] : ["signing discovery"]),
    ...requiredVerification.filter((fragment) => !verifyRun.includes(fragment)),
    ...(download >= 0 && download < install && install < build && build < verify && verify < attest
      ? []
      : ["ordering"]),
    ...(installRun.includes("$runtime = (Resolve-Path candidate-input/wsl/bharatcode-runtime-linux-x64-glibc).Path")
      ? []
      : ["runtime path"]),
    ...(installRun.includes("$manifest = (Resolve-Path candidate-input/wsl/manifest.json).Path")
      ? []
      : ["manifest path"]),
    ...(installRun.includes(runtimeReadOnly) && installRun.indexOf(runtimeReadOnly) < installRun.indexOf(stageRuntime)
      ? []
      : ["runtime immutability"]),
    ...(installRun.includes(manifestReadOnly) && installRun.indexOf(manifestReadOnly) < installRun.indexOf(stageRuntime)
      ? []
      : ["manifest immutability"]),
    ...(steps[verify]?.if === undefined ? [] : ["disabled unsigned-policy step"]),
    ...(/(?:^|\n)\s*(?:exit|return)\b/iu.test(verifyRun) ? ["verification early exit"] : []),
    ...(value.includes("AZURE_") || value.includes("azure/login@") || value.includes("EXPECTED_WINDOWS_PUBLISHER")
      ? ["obsolete signing input"]
      : []),
    ...(value.includes("sign-windows.ps1") || value.includes("Invoke-TrustedSigning")
      ? ["obsolete signing implementation"]
      : []),
  ]
}

describe("lean next-beta candidate workflow", () => {
  test("is manual-only and binds one exact 1.15.24 source plus a fresh WSL decision", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      "source_sha",
      "wsl_acceptance_mode",
      "publish_release",
      "notify_website",
    ])
    expect(workflow.on.workflow_dispatch.inputs.wsl_acceptance_mode).toEqual({
      description: "Require formal WSL2 automation, or record a fresh owner-authorized 1.15.24 waiver",
      required: true,
      default: "required",
      type: "choice",
      options: ["required", "owner-waived-hotfix-1.15.24"],
    })
    expect(value).toContain("^[0-9a-f]{40}$")
    expect(value).toContain("github.ref == 'refs/heads/codex/desktop-1.15.24-release-control'")
    expect(value).toContain("github.sha")
    expect(value).toContain("inputs.source_sha")
    expect(value).toContain("ref: ${{ inputs.source_sha }}")
    expect(value).toContain("RELEASE_TAG: desktop-beta-1.15.24")
    const admission = runStep(value, "admit-source", "Admit immutable source and source-derived versions")
    expect(value).toContain(acceptedApplicationSourceSha)
    expect(value).toContain(`ACCEPTED_RELEASE_PARENT_SHA: ${acceptedReleaseParentSha}`)
    expect(admission).toContain('git rev-parse "$SOURCE_SHA^"')
    expect(admission).toContain('== "$ACCEPTED_RELEASE_PARENT_SHA"')
    expect(value).toContain("git merge-base --is-ancestor")
    for (const path of releaseControlDeltaPaths) expect(admission).toContain(path)
    const root = resolve(import.meta.dir, "../../../..")
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(git("merge-base", "--is-ancestor", acceptedApplicationSourceSha, "HEAD").exitCode).toBe(0)
    expect(git("diff", "--quiet", acceptedReleaseParentSha, "HEAD", "--", ...frozenWslPaths).exitCode).toBe(0)
  })

  test("requires one immutable run-attempt-scoped WSL runner label through cohort finalization", async () => {
    const value = await source()
    const first = renderWslRunnerLabels(value, "29722640762", "1")
    const second = renderWslRunnerLabels(value, "29722640762", "2")
    expect(first).toEqual(["self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29722640762-1"])
    expect(second).toEqual(["self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29722640762-2"])
    expect(first.at(-1)).not.toBe(second.at(-1))
    expect(wslRunnerBindingViolations(value)).toEqual([])

    const staticFallback = value.replace(wslRunnerLabel, "bharatcode-acceptance")
    expect(renderWslRunnerLabels(staticFallback, "29722640762", "1").at(-1)).toBe(
      renderWslRunnerLabels(staticFallback, "29722640762", "2").at(-1),
    )
    expect(wslRunnerBindingViolations(staticFallback)).not.toEqual([])
    expect(
      wslRunnerBindingViolations(value.replace(wslRunnerLabel, "bharatcode-acceptance-${{ inputs.source_sha }}")),
    ).not.toEqual([])
    expect(wslRunnerBindingViolations(value.replace("      - accept-wsl\n", ""))).not.toEqual([])
    expect(
      wslRunnerBindingViolations(
        value.replace("cp2-*-${{ github.run_id }}-${{ github.run_attempt }}", "cp2-*-${{ github.run_id }}-1"),
      ),
    ).not.toEqual([])
    expect(() => renderWslRunnerLabels(value, "0", "1")).toThrow("test run identity is invalid")
    expect(() => renderWslRunnerLabels(value, "29722640762", "01")).toThrow("test run identity is invalid")
  })

  test("pins every action and Bun while confining publication and denying overwrite authority", async () => {
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
        "publish-release",
        "record-wsl-waiver",
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
        "record-wsl-waiver",
        "upgrade-rollback-windows-x64",
      ].sort(),
    )
    for (const key of REQUIRED_COHORT_KEYS) expect(value).toContain(key)
    expect(value).toContain("bharatcode-next-beta-cohort.json")
    expect(value).toContain("bharatcode-next-beta-cohort-v2")
    expect(value).toContain("canonicalLeanJson")
    expect(value).toContain("validateLeanCohort")
    expect(value).toContain("github.run_id")
    expect(value).toContain("github.run_attempt")
  })

  test("installs and proves the exact cross-platform native build dependencies before immutable skip-install builds", async () => {
    const value = await source()
    const opencode = await Bun.file(resolve(import.meta.dir, "../../package.json")).json()
    const opentui = await Bun.file(
      Bun.resolveSync("@opentui/core/package.json", resolve(import.meta.dir, "../..")),
    ).json()
    expect(watcherNativeNames.every((name) => opencode.devDependencies[name] === "2.5.1")).toBeTrue()
    expect(opentuiNativeNames.every((name) => opentui.optionalDependencies[name] === "0.2.15")).toBeTrue()
    expect(nativeBuildViolations(value)).toEqual([])
    expect(
      nativeBuildViolations(
        value.replace(
          "bun install --frozen-lockfile --linker hoisted --os='*' --cpu='*'",
          "bun install --frozen-lockfile --linker hoisted",
        ),
      ),
    ).not.toEqual([])
    expect(nativeBuildViolations(value.replace("opentui.length !== 6", "opentui.length !== 5"))).not.toEqual([])
    expect(nativeBuildViolations(value.replace("watcher.length !== 8", "watcher.length !== 7"))).not.toEqual([])
    expect(nativeBuildViolations(value.replace("manifest.version !== version", "false"))).not.toEqual([])
    expect(
      nativeBuildViolations(value.replace("opencode.devDependencies[name]", "opencode.dependencies[name]")),
    ).not.toEqual([])
    expect(
      nativeBuildViolations(value.replace("opentuiManifest.optionalDependencies[name]", "opencode.dependencies[name]")),
    ).not.toEqual([])
    expect(nativeBuildViolations(value.replace("payload.bytes !== bytes.length", "false"))).not.toEqual([])
    expect(nativeBuildViolations(value.replace('new Bun.CryptoHasher("sha256")', "removedPayloadHasher"))).not.toEqual(
      [],
    )
    expect(nativeBuildViolations(value.replace("view.getUint16(18, true)", "0x3e"))).not.toEqual([])
    expect(
      nativeBuildViolations(
        value.replace(nativePayloads["@opentui/core-linux-arm64"][2], nativePayloads["@opentui/core-linux-x64"][2]),
      ),
    ).not.toEqual([])
    expect(
      nativeBuildViolations(value.replace('"@opentui/core-linux-arm64":', '"@opentui/core-linux-s390x":')),
    ).not.toEqual([])
    expect(
      nativeBuildViolations(value.replace('"@parcel/watcher-win32-x64":', '"@parcel/watcher-win32-ia32":')),
    ).not.toEqual([])
    expect(nativeBuildViolations(value.replace("git status --porcelain=v1", "git diff --quiet"))).not.toEqual([])
    expect(nativeBuildViolations(value.replaceAll(" --skip-install", ""))).not.toEqual([])
    for (const [current, hostile] of [
      ["/^\\d+\\.\\d+\\.\\d+$/.test(versions.opentui)", "true"],
      ["const packageDir = realpathSync(dirname(manifestPath))", "const packageDir = dirname(manifestPath)"],
      ["entry !== packageDir && !entry.startsWith(`${packageDir}${sep}`)", "false"],
      ["const payloadPath = realpathSync(payloadResolution)", "const payloadPath = payloadResolution"],
      ["!payloadPath.startsWith(`${packageDir}${sep}`)", "false"],
      ['"7f454c460201"', '"000000000000"'],
      ["0xb7", "0"],
      ["0x3e", "0"],
      ["0xfeedfacf", "0"],
      ["0x0100000c", "0"],
      ["0x01000007", "0"],
      ["bytes[0] !== 0x4d || bytes[1] !== 0x5a", "false"],
      ["peOffset + 6 > bytes.length", "false"],
      ["view.getUint32(peOffset, true) !== 0x00004550", "false"],
      ["0xaa64", "0"],
      ["0x8664", "0"],
    ]) {
      expect(value).toContain(current)
      expect(nativeBuildViolations(value.replace(current, hostile))).not.toEqual([])
    }
    const nativePreflight = bunEvalScripts(
      runStep(value, "build-cli", "Preflight exact cross-platform native dependencies"),
    )[0]
    expect(nativePreflight).toBeDefined()
    expect(nativePreflightExecutionViolations(nativePreflight)).toEqual([])
    const originBypass = nativePreflight
      .replace(" || !manifestPath.startsWith(`${approvedDependencyRoot}${sep}`)", "")
      .replace("manifestResolution !== manifestPath || ", "")
      .replace(
        "if (!packageDir.startsWith(`${approvedDependencyRoot}${sep}`)) throw new Error(`native package directory origin drift: ${name}`)",
        "",
      )
      .replace(" || !entry.startsWith(`${approvedDependencyRoot}${sep}`)", "")
      .replace("entryResolution !== entry || ", "")
      .replace(" || !payloadPath.startsWith(`${approvedDependencyRoot}${sep}`)", "")
      .replace("payloadResolution !== payloadPath || ", "")
    expect(nativePreflightExecutionViolations(originBypass)).toContain("package-origin")
    expect(
      nativePreflightExecutionViolations(
        nativePreflight.replace("const payloads = {", "process.exit(0)\nconst payloads = {"),
      ),
    ).not.toEqual([])
    expect(
      nativePreflightExecutionViolations(
        nativePreflight.replace(
          "if (JSON.stringify(Object.keys(payloads).sort())",
          "process.exit(0)\nif (JSON.stringify(Object.keys(payloads).sort())",
        ),
      ),
    ).not.toEqual([])
    expect(
      nativePreflightExecutionViolations(
        nativePreflight
          .replace("if (payload.bytes !== bytes.length ||", "if (false && (payload.bytes !== bytes.length ||")
          .replace("!== payload.sha256) throw", "!== payload.sha256)) throw"),
      ),
    ).not.toEqual([])
    expect(
      nativeBuildViolations(
        value.replace(
          "      - name: Preflight exact cross-platform native dependencies",
          "      - name: Preflight exact cross-platform native dependencies\n        if: ${{ false }}",
        ),
      ),
    ).not.toEqual([])
  })

  test("validates native provenance in the exact hoisted repository node_modules layout", async () => {
    const value = await source()
    const install = runStep(value, "build-cli", "Install exact dependencies")
    const preflight = runStep(value, "build-cli", "Preflight exact cross-platform native dependencies")
    const script = bunEvalScripts(preflight)[0]
    expect(install).toBe("bun install --frozen-lockfile --linker hoisted --os='*' --cpu='*'")
    expect(preflight).toContain('const approvedDependencyRoot = realpathSync(resolve(workspaceRoot, "node_modules"))')
    expect(preflight).toContain('approvedDependencyRoot !== resolve(workspaceRoot, "node_modules")')
    expect(preflight).not.toContain("node_modules/.bun")
    expect(script).toBeDefined()
    expect(nativePreflightExecutionViolations(script)).toEqual([])
  })

  test("packs the complete meta launcher import graph and executes it through global and npx acceptance", async () => {
    const value = await source()
    const build = runStep(value, "build-cli", "Build and pack the exact CLI cohort and Desktop WSL runtime")
    const assembly = bunEvalScripts(build)[0]
    expect(assembly).toBeDefined()
    expect(metaPackageBuildViolations(assembly)).toEqual([])
    expect(await runWorkflowMetaPackageFixture(assembly)).toEqual([])
    const missingDistribution = assembly.replace(
      '    { source: resolve("packages/opencode/script/distribution.mjs"), target: resolve(metaRoot, "script/distribution.mjs"), packagePath: "package/script/distribution.mjs" },\n',
      "",
    )
    expect(missingDistribution).not.toBe(assembly)
    expect(await runWorkflowMetaPackageFixture(missingDistribution)).toContain("workflow meta assembly")
    expect(metaPackageBuildViolations(assembly.replace('type: "module", ', ""))).not.toEqual([])
    expect(
      metaPackageBuildViolations(
        assembly.replace(
          "sourceBytes.length !== targetBytes.length || digest(sourceBytes) !== digest(targetBytes)",
          "false",
        ),
      ),
    ).not.toEqual([])
  })

  test("normalizes and validates the Windows npm global layout before direct and npx execution", async () => {
    const value = await source()
    const run = runStep(value, "accept-cli-native", "Install meta and platform tarballs globally, then execute npx")
    const result = runWindowsGlobalAcceptanceFixture(run)
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" })
    expect(result.stdout.toString()).toContain("native CLI layout verified: windows-global")
    expect(
      result.stdout
        .toString()
        .split("\n")
        .filter((line) => line === "0.0.0-run4-fixture.1"),
    ).toHaveLength(1)
    expect(nativeAcceptanceLayoutViolations(run)).toEqual([])
    const rawPrefix = run.replace('prefix_path="$(cygpath -u "$prefix")"', 'prefix_path="$prefix"')
    const hostile = runWindowsGlobalAcceptanceFixture(rawPrefix)
    expect(hostile.exitCode).not.toBe(0)
    expect(hostile.stderr.toString()).toBe("native CLI acceptance layout validation failed\n")
    expect(nativeAcceptanceLayoutViolations(rawPrefix)).not.toEqual([])
    const validationStart = run.indexOf("fail_layout() {")
    const executionStart = run.indexOf('[[ "$(bharatcode --version)" == "$CLI_VERSION" ]]')
    expect(validationStart).toBeGreaterThan(0)
    expect(executionStart).toBeGreaterThan(validationStart)
    const failOpen = `${run.slice(0, validationStart)}export PATH="$prefix/bin:$prefix:$PATH"\n${run.slice(executionStart)}`
    const reproduced = runWindowsGlobalAcceptanceFixture(failOpen)
    expect(reproduced.exitCode).not.toBe(0)
    expect(reproduced.stderr.toString()).toContain("A:\\_temp\\bharatcode-cli-native")
  })

  test("binds Run-1 Linux and macOS package evidence to the real AppRun target and protected signer identity", async () => {
    const value = await source()
    const canonicalAppRun = Bun.gunzipSync(Buffer.from(canonicalAppRunGzip, "base64"))
    expect(canonicalAppRun).toHaveLength(2356)
    expect(new Bun.CryptoHasher("sha256").update(canonicalAppRun).digest("hex")).toBe(canonicalAppRunSha256)
    const hostileAppRun = Buffer.concat([
      canonicalAppRun,
      Buffer.from('\nif false; then exec "$BIN"; fi\nexec "$APPDIR/alternate"\n'),
    ])
    const hostileAppRunSha256 = new Bun.CryptoHasher("sha256").update(hostileAppRun).digest("hex")
    expect(hostileAppRunSha256).not.toBe(canonicalAppRunSha256)
    const appRunStep = runStep(value, "package-linux", "Build Linux packages")
    const appRunValidation = appRunVerificationScript(appRunStep)
    expect(appRunStepExecutionViolations(appRunStep)).toEqual([])
    expect(appRunExecutionViolations(`if false; then\n${appRunValidation}\nfi`)).not.toEqual([])
    expect(
      appRunStepExecutionViolations(
        appRunStep.replace("bash -n squashfs-root/AppRun", "exit 0\nbash -n squashfs-root/AppRun"),
      ),
    ).not.toEqual([])
    expect(
      appRunStepExecutionViolations(
        appRunStep
          .replace("bash -n squashfs-root/AppRun", "if false; then\nbash -n squashfs-root/AppRun")
          .replace(
            "file -L -b \"$appimage_target\" | grep -E '^ELF 64-bit LSB (pie )?executable, x86-64,'",
            "file -L -b \"$appimage_target\" | grep -E '^ELF 64-bit LSB (pie )?executable, x86-64,'\nfi",
          ),
      ),
    ).not.toEqual([])
    expect(appRunStepExecutionViolations(appRunStep, true)).not.toEqual([])
    const identityCheck = bunEvalScripts(
      runStep(value, "package-macos", "Build signed, notarized, stapled macOS package"),
    )[0]
    expect(identityCheck).toBeDefined()
    const validateIdentity = (subject: string | undefined, team: string | undefined) => {
      const env = { ...Bun.env }
      if (subject === undefined) delete env.EXPECTED_APPLE_DEVELOPER_ID_SUBJECT
      else env.EXPECTED_APPLE_DEVELOPER_ID_SUBJECT = subject
      if (team === undefined) delete env.APPLE_TEAM_ID
      else env.APPLE_TEAM_ID = team
      return Bun.spawnSync(["bun", "--eval", identityCheck], { env, stdout: "pipe", stderr: "pipe" })
    }
    expect(validateIdentity("Shrey Gupta", "ABCDE12345").exitCode).toBe(0)
    for (const subject of [undefined, "", "Shrey\nGupta", " Shrey Gupta", "Shrey/Gupta"]) {
      const result = validateIdentity(subject, "ABCDE12345")
      expect(result.exitCode).not.toBe(0)
      if (subject) expect(result.stderr.toString()).not.toContain(subject)
    }
    for (const team of [undefined, "", "ABCDE\n1234", "abcde12345", "ABCDE123456", "ABCD*12345"]) {
      const result = validateIdentity("Shrey Gupta", team)
      expect(result.exitCode).not.toBe(0)
      if (team) expect(result.stderr.toString()).not.toContain(team)
    }
    expect(runOnePackagingViolations(value)).toEqual([])
    expect(runOnePackagingViolations(value.replace(canonicalAppRunSha256, hostileAppRunSha256))).not.toEqual([])
    expect(runOnePackagingViolations(value.replace("bash -n squashfs-root/AppRun", ":"))).not.toEqual([])
    expect(
      runOnePackagingViolations(
        value.replace('appimage_target="squashfs-root/$expected_package"', 'appimage_target="squashfs-root/AppRun"'),
      ),
    ).not.toEqual([])
    expect(runOnePackagingViolations(value.replace("executable, x86-64,", "executable,"))).not.toEqual([])
    expect(
      runOnePackagingViolations(
        value.replace(
          "vars.BHARATCODE_EXPECTED_APPLE_DEVELOPER_ID_SUBJECT",
          "vars.MISSING_EXPECTED_APPLE_DEVELOPER_ID_SUBJECT",
        ),
      ),
    ).not.toEqual([])
    expect(runOnePackagingViolations(value.replace(".test(value)", '.test("hardcoded")'))).not.toEqual([])
    expect(runOnePackagingViolations(value.replace("(${APPLE_TEAM_ID})", ""))).not.toEqual([])
    expect(runOnePackagingViolations(value.replace("Authority=Apple Root CA", "Authority=Untrusted Root"))).not.toEqual(
      [],
    )
  })

  test("enforces the explicit unsigned Windows policy without signing authority", async () => {
    const value = await source()
    expect(windowsUnsignedPolicyViolations(value)).toEqual([])
    expect(securityEnclosureViolations(value)).toEqual([])
    expect(value).toContain('BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "1"')
    expect(value).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"')
    expect(value).toContain('$signature.Status -ne "NotSigned"')
    expect(value).not.toContain("AZURE_")
    expect(value).not.toContain("azure/login@")
    expect(value).not.toContain("EXPECTED_WINDOWS_PUBLISHER")
    expect(value).not.toContain("Invoke-TrustedSigning")
    expect(value).not.toContain("sign-windows.ps1")

    for (const [current, hostile] of [
      ['BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "1"', 'BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "0"'],
      ['CSC_IDENTITY_AUTO_DISCOVERY: "false"', 'CSC_IDENTITY_AUTO_DISCOVERY: "true"'],
      ['$signature.Status -ne "NotSigned"', "$false"],
      ["$null -ne $signature.SignerCertificate", "$false"],
      ["$null -ne $signature.TimeStamperCertificate", "$false"],
    ] as const) {
      expect(windowsUnsignedPolicyViolations(value.replaceAll(current, hostile))).not.toEqual([])
    }

    const disabled = value.replace(
      "      - name: Verify unsigned Windows policy and package version",
      "      - name: Verify unsigned Windows policy and package version\n        if: ${{ false }}",
    )
    expect(windowsUnsignedPolicyViolations(disabled)).not.toEqual([])
    expect(securityEnclosureViolations(disabled)).toContain("disabled Windows security step")

    for (const [label, hostile] of [
      [
        "native preflight",
        value.replace(
          "      - name: Preflight exact cross-platform native dependencies\n        shell: bash",
          "      - name: Preflight exact cross-platform native dependencies\n        continue-on-error: true\n        shell: bash",
        ),
      ],
      [
        "Windows unsigned policy",
        value.replace(
          "      - name: Verify unsigned Windows policy and package version\n        shell: pwsh",
          "      - name: Verify unsigned Windows policy and package version\n        continue-on-error: true\n        shell: pwsh",
        ),
      ],
    ] as const) {
      expect(closedSecurityStepViolations(hostile).some((item) => item.startsWith(label))).toBeTrue()
    }

    expect(
      securityEnclosureViolations(
        value.replace(
          "$signature = Get-AuthenticodeSignature bharatcode-desktop-next-beta-win-x64.exe",
          "if ($false) {\n          $signature = Get-AuthenticodeSignature bharatcode-desktop-next-beta-win-x64.exe",
        ),
      ),
    ).not.toEqual([])
  })
  test("requires native package, unsigned policy, notarization, WSL, CLI, attestation, and API checks", async () => {
    const value = await source()
    for (const required of [
      "Get-AuthenticodeSignature",
      'Status -ne "NotSigned"',
      "SignerCertificate",
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
    const fixture = parseCurrentBetaFixtureBytes(
      new Uint8Array(await Bun.file(resolve(import.meta.dir, `../../../../${currentBetaFixture}`)).arrayBuffer()),
    )
    expect(fixture.tag).toBe("desktop-beta-1.15.23")
    expect(fixture.source_sha).toBe("0ee3879a06275b55a432a5ed4bd63695aae16be1")
    expect(fixture.assets[0].filename).toBe("bharatcode-desktop-next-beta-win-x64.exe")
    expect(value).toContain(`--fixture ${currentBetaFixture}`)
    expect(value).not.toContain("packages/desktop/test/fixtures/lean-current-beta.json")
  })

  test("requires the assigned independent reviewer for each publication stage", async () => {
    const value = await source()
    const policy = await Bun.file(resolve(import.meta.dir, `../../../../${releaseReviewAuthority}`)).text()

    expect(value).toContain("environment: desktop-beta-release")
    expect(policy).toContain("`desktop-beta-release` requires approval from `Pankaj-IIT`")
    expect(policy).toContain("`npm-next` stage separately requires `Pankaj-IIT`")
    expect(policy).toContain("`npm-latest` stage requires an independent approval")
    expect(policy).toContain("from `satyamlohiya`")
    expect(policy).toContain("`prevent_self_review` enabled")
    expect(policy).toContain("administrator bypass is not accepted as review evidence")
    expect(policy).toContain("Reviewer assignment alone does not permit workflow dispatch")
  })

  test("records the one-release owner waiver without claiming formal WSL scenarios passed", async () => {
    const value = await source()
    const workflow = parse(value)
    const job = workflow.jobs["record-wsl-waiver"]
    expect(job.if).toBe("inputs.wsl_acceptance_mode == 'owner-waived-hotfix-1.15.24'")
    expect(workflow.jobs["accept-wsl"].if).toBe("inputs.wsl_acceptance_mode == 'required'")
    const run = runStep(value, "record-wsl-waiver", "Record exact owner-authorized WSL automation waiver")
    expect(run).toContain('result: "OWNER_WAIVED"')
    expect(run).toContain('reason: "FORMAL_WINDOWS_WSL2_VM_ACCEPTANCE_NOT_RUN_BY_OWNER_DECISION"')
    expect(run).toContain("accepted_application_source_sha: process.env.ACCEPTED_APPLICATION_SOURCE_SHA")
    expect(run).toContain("validateLeanWslWaiver")
    expect(run).not.toContain('result: "PASS"')
    expect(value).toContain("80c962f4148db531c35abcf4922059d2101c9bcd")
    expect(value).toContain("bharatcode-wsl-acceptance-waiver.json")
    expect(value).toContain("owner-waiver-receipt")
    const digest = runWorkflowDigestFixture(run)
    expect(digest.exitCode).toBe(0)
    expect(digest.stdout.toString()).toBe(
      new Bun.CryptoHasher("sha256").update("bharatcode-workflow-digest-fixture").digest("hex"),
    )
    const waiver = runWorkflowWaiverFixture(run)
    expect(waiver.exitCode).toBe(0)
    expect(waiver.receipt?.result).toBe("OWNER_WAIVED")
    expect(waiver.receipt?.source_sha).toBe("a".repeat(40))
  })

  test("attests exactly every cohort subject while excluding closed internal WSL inputs", async () => {
    const value = await source()
    const run = runStep(value, "assemble-cohort", "Verify every artifact attestation against exact source and signer")
    expect(bashArray(run, "cohort_subjects")).toEqual(cohortSubjectNames.slice(0, -1))
    expect(cohortSubjectNames).toHaveLength(REQUIRED_COHORT_KEYS.length)
    expect(cohortSubjectNames).not.toContain("bharatcode-wsl-runtime-manifest.json")
    expect(run).toContain('cohort_subjects+=("bharatcode-wsl-scenarios-9-10.json")')
    expect(run).toContain('cohort_subjects+=("bharatcode-wsl-acceptance-waiver.json")')
    for (const internal of internalWslInputs) expect(run).toContain(`! -name '${internal}'`)
    expect(run).toContain('[[ "${#actual_subjects[@]}" -eq "${#cohort_subjects[@]}" ]]')
    expect(run.replace("! -name 'bharatcode-wsl-runtime-manifest.json'", "")).not.toContain(
      "! -name 'bharatcode-wsl-runtime-manifest.json'",
    )
    const updaterScript = bunEvalScripts(
      runStep(value, "assemble-cohort", "Normalize and verify updater artifacts against exact packages"),
    ).find((script) => script.includes("validateLeanUpdaterInfo"))
    expect(updaterScript).toBeDefined()
    const cohort = runWorkflowCohortFixture(
      runStep(value, "assemble-cohort", "Rehash, close, and validate final manifest"),
      undefined,
      updaterScript,
    )
    expect(cohort.exitCode).toBe(0)
    expect(cohort.manifest?.wsl_gate_result).toBe("OWNER_WAIVED")
    expect(cohort.manifest?.artifacts).toHaveLength(REQUIRED_COHORT_KEYS.length)
    expect(cohort.checksum).toMatch(/^[0-9a-f]{64}  bharatcode-next-beta-cohort\.json\n$/u)
  })

  test("carries exact updater metadata and blockmaps through producers, attestation, and cohort publication", async () => {
    const value = await source()
    const workflow = parse(value)
    const producerBindings = [
      ["package-windows", "bharatcode-desktop-next-beta-win-x64.exe.producer.blockmap"],
      ["package-windows", "beta-windows.producer.yml"],
      ["package-macos", "bharatcode-desktop-next-beta-mac-${{ matrix.arch }}.zip.producer.blockmap"],
      ["package-macos", "beta-mac-${{ matrix.arch }}.producer.yml"],
      ["package-linux", "beta-linux.producer.yml"],
    ] as const
    for (const [job, filename] of producerBindings) {
      expect(JSON.stringify(workflow.jobs[job])).toContain(filename)
    }

    const prepare = runStep(value, "assemble-cohort", "Normalize and verify updater artifacts against exact packages")
    for (const required of [
      "validateLeanUpdaterInfo",
      'createHash("sha512")',
      "Bun.YAML.parse(await Bun.file(one(producer)).text())",
      "files: expected",
      "Bun.YAML.stringify(value)",
      '"beta.yml"',
      '"beta-mac.yml"',
      '"beta-linux.yml"',
      '"bharatcode-desktop-next-beta-win-x64.exe.blockmap"',
      '"bharatcode-desktop-next-beta-mac-arm64.zip.blockmap"',
      '"bharatcode-desktop-next-beta-mac-x64.zip.blockmap"',
    ])
      expect(prepare).toContain(required)
    expect(prepare).not.toContain("value?.files?.map")

    const updaterAttestations = (workflow.jobs["assemble-cohort"].steps ?? []).filter((step) =>
      step.name?.startsWith("Attest "),
    )
    expect(updaterAttestations).toHaveLength(7)
    for (const filename of [
      "beta.yml",
      "beta-mac.yml",
      "beta-linux.yml",
      "bharatcode-desktop-next-beta-win-x64.exe.blockmap",
      "bharatcode-desktop-next-beta-mac-arm64.zip.blockmap",
      "bharatcode-desktop-next-beta-mac-x64.zip.blockmap",
    ]) {
      expect(
        updaterAttestations.some((step) => step.with?.["subject-path"] === `updater-assets/${filename}`),
      ).toBeTrue()
      expect(value).toContain(`${filename}.intoto.jsonl`)
    }
    expect(JSON.stringify(workflow.jobs["assemble-cohort"])).toContain("updater-assets")
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

  test("binds each attestation bundle digest separately from its attested subject digest", async () => {
    const run = runStep(await source(), "assemble-cohort", "Rehash, close, and validate final manifest")
    expect(run).toContain("const subjectSha256 = await digest(path)")
    expect(run).toContain("sha256: await digest(bundle), subject_sha256: subjectSha256")
    expect(run).not.toContain("bytes: (await stat(bundle)).size, sha256: await digest(path)")
    expect(runWorkflowDigestFixture(run).exitCode).toBe(0)
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
    const checkoutPolicy = steps.findIndex((step) => step.name === "Pin binary checkout semantics")
    const checkout = steps.findIndex((step) => step.name === "Checkout the exact candidate")
    const harness = steps.findIndex((step) => step.name === "Run real packaged upgrade and rollback acceptance")
    const validation = steps.findIndex((step) => step.name === "Validate packaged upgrade receipt before attestation")
    const attestation = steps.findIndex((step) => step.name === "Attest upgrade and rollback receipt")
    expect(checkoutPolicy).toBeGreaterThan(-1)
    expect(checkout).toBeGreaterThan(checkoutPolicy)
    expect(steps[checkoutPolicy]?.run).toContain("git config --global core.autocrlf false")
    expect(steps[checkoutPolicy]?.run).toContain("git config --global core.eol lf")
    expect(harness).toBeGreaterThan(-1)
    expect(steps[harness]?.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" })
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
    expect(authorityViolations(`${value}\n# BHARATCODE_ALLOW_UNSIGNED_MAC=1\n`)).not.toEqual([])
    expect(value.replaceAll("ref: ${{ inputs.source_sha }}", "ref: dev")).not.toContain("ref: ${{ inputs.source_sha }}")
    expect(value.replace(checkout, "actions/checkout@v7")).toContain("actions/checkout@v7")
    expect(value.replaceAll("desktop-windows-x64", "desktop-windows-arm64")).not.toContain("desktop-windows-x64")
  })

  test("publishes only an exact complete draft cohort before prerelease and website cutover", async () => {
    const value = await source()
    const workflow = parse(value)
    const publish = workflow.jobs["publish-release"] as (typeof workflow.jobs)[string] & { environment?: string }
    expect(publish.if).toBe("inputs.publish_release == true")
    expect((publish as unknown as { needs: string }).needs).toBe("assemble-cohort")
    expect(publish.environment).toBe("desktop-beta-release")
    expect(publish.permissions).toEqual({ contents: "write" })
    const steps = publish.steps ?? []
    const stage = steps.findIndex((step) => step.name === "Revalidate and stage complete public update cohort")
    const refuse = steps.findIndex((step) => step.name === "Refuse overwrite and verify rollback release")
    const create = steps.findIndex((step) => step.name === "Create draft and upload without overwrite")
    const verify = steps.findIndex((step) => step.name === "Verify draft asset identities and live URLs")
    const finalize = steps.findIndex((step) => step.name === "Finalize verified prerelease")
    const notify = steps.findIndex((step) => step.name === "Notify website after finalization")
    expect([stage, refuse, create, verify, finalize, notify].every((index) => index >= 0)).toBeTrue()
    expect(stage).toBeLessThan(refuse)
    expect(refuse).toBeLessThan(create)
    expect(create).toBeLessThan(verify)
    expect(verify).toBeLessThan(finalize)
    expect(finalize).toBeLessThan(notify)
    const stageRun = steps[stage]?.run ?? ""
    for (const identity of [
      '"desktop-windows-x64", ["bharatcode-desktop-next-beta-win-x64.exe", "unsigned"]',
      '"desktop-macos-arm64", ["bharatcode-desktop-next-beta-mac-arm64.zip", "apple-notarized-stapled"]',
      '"desktop-macos-x64", ["bharatcode-desktop-next-beta-mac-x64.zip", "apple-notarized-stapled"]',
      '"desktop-linux-x64-appimage", ["bharatcode-desktop-next-beta-linux-x64.AppImage", "not-applicable"]',
      '"desktop-linux-x64-deb", ["bharatcode-desktop-next-beta-linux-x64.deb", "not-applicable"]',
      '"desktop-windows-update-info", ["beta.yml", "not-applicable"]',
      '"desktop-windows-x64-blockmap", ["bharatcode-desktop-next-beta-win-x64.exe.blockmap", "not-applicable"]',
      '"desktop-macos-update-info", ["beta-mac.yml", "not-applicable"]',
      '"desktop-macos-arm64-blockmap", ["bharatcode-desktop-next-beta-mac-arm64.zip.blockmap", "not-applicable"]',
      '"desktop-macos-x64-blockmap", ["bharatcode-desktop-next-beta-mac-x64.zip.blockmap", "not-applicable"]',
      '"desktop-linux-x64-update-info", ["beta-linux.yml", "not-applicable"]',
    ])
      expect(stageRun).toContain(identity)
    const refuseRun = steps[refuse]?.run ?? ""
    expect(value).toContain("PREVIOUS_RELEASE_TAG: desktop-beta-1.15.23")
    expect(refuseRun).toContain("Release already exists; refusing overwrite.")
    expect(refuseRun).toContain("Tag already exists; refusing mixed provenance.")
    const createRun = steps[create]?.run ?? ""
    expect(createRun).toContain('gh release create "$RELEASE_TAG"')
    expect(createRun).toContain("--draft --prerelease")
    expect(createRun).toContain('[[ "${#assets[@]}" -eq 26 ]]')
    expect(createRun).not.toContain("--clobber")
    expect(steps[notify]?.if).toBe("inputs.notify_website == true")
    expect(steps[notify]?.env).toEqual({ GH_TOKEN: "${{ secrets.BHARATCODE_WEBSITE_DISPATCH_TOKEN }}" })
    expect(steps[notify]?.run).toContain('"event_type": "desktop_release_published"')
    expect(value).not.toMatch(/gh\s+release\s+delete|git\s+push\s+.*--force/iu)

    const assemblyRun = runStep(value, "assemble-cohort", "Rehash, close, and validate final manifest")
    const assemblyScript = bunEvalScripts(assemblyRun).find((script) => script.includes("validateLeanCohort"))
    const stageScript = bunEvalScripts(stageRun).find((script) => script.includes("Public release asset set drift"))
    expect(assemblyScript).toBeDefined()
    expect(stageScript).toBeDefined()
    const updaterRun = runStep(
      value,
      "assemble-cohort",
      "Normalize and verify updater artifacts against exact packages",
    )
    const updaterScript = bunEvalScripts(updaterRun).find((script) => script.includes("validateLeanUpdaterInfo"))
    expect(updaterScript).toBeDefined()
    const fixture = runWorkflowCohortFixture(assemblyRun, stageScript, updaterScript)
    expect(fixture.exitCode).toBe(0)
    expect(fixture.releaseStageError).toBe("")
    expect(fixture.releaseStageExitCode).toBe(0)
    expect(fixture.releaseAssets).toHaveLength(26)
    expect(fixture.releaseAssets).toContain("SHA256SUMS")
    expect(fixture.releaseAssets).toContain("beta.yml")
    expect(fixture.releaseAssets).toContain("beta-mac.yml")
    expect(fixture.releaseAssets).toContain("beta-linux.yml")
  })
})
