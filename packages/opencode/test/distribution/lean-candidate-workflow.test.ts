import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { REQUIRED_COHORT_KEYS } from "../../script/lean-cohort.mjs"

const workflowPath = resolve(import.meta.dir, "../../../../.github/workflows/bharatcode-next-beta-candidate.yml")
const checkout = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const upload = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const download = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
const attest = "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6"
const azureLogin = "azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43"
const reviewedSecurityEnclosureSha256 = {
  nativePreflight: "48de8947a8f5eda336219b3cdbdfb0ff128c24c2268b18e4c0621242374a7a5b",
  linuxPackage: "5120170c09954e6e2d57d72cd856cd1e3c193b19cfe8243d20154b73d5289b67",
  windowsPreflight: "7ae4ff03740ad94b8a24c83ae22db01e8825221b2d3238adca3d75a65de5c0ba",
  windowsAuthenticode: "01359917d489dc0dc9fe7e2f16b24008c69d324573f5b9b9af62194d2b72169d",
  windowsSigner: "a9e6e0b3732b9dddbae80d6539f061f6935d7cd15bfefc614084b67e08511c5d",
} as const
const reviewedSecurityStepSha256 = {
  nativePreflight: "f3f46d099dbd6fd4f821a156b2ae7fd68f5d943b0db2316152ded666b4b817dc",
  linuxPackage: "54d38a70454ffd857a51ca05848eb30afc19bcd86dbe22d1d9b5944ac3fbf8d7",
  windowsPreflight: "89f6c8b0d43faf38a3cadc4e31505bc820be2a90ffd19060c22153aa45d460e2",
  windowsAuthenticode: "20c44131417eff06359c17cfdcd81fa45a4f4bdd73cea224ce88e0ac2ce08db1",
} as const
const acceptedWslSha = "a30c6923f2f532258de58d84b65445198be1b351"
const currentBetaFixture = "packages/desktop/test/fixtures/current-beta-windows-x64.json"
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
        steps?: {
          name?: string
          run?: string
          uses?: string
          if?: unknown
          shell?: string
          with?: Record<string, unknown>
        }[]
      }
    >
  }
}

function runStep(value: string, job: string, name: string) {
  return parse(value).jobs[job].steps?.find((step) => step.name === name)?.run ?? ""
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
      "Windows preflight",
      "package-windows",
      "Preflight protected Windows signing identity",
      "pwsh",
      reviewedSecurityStepSha256.windowsPreflight,
    ],
    [
      "Authenticode",
      "package-windows",
      "Verify Authenticode publisher and trusted timestamp",
      "pwsh",
      reviewedSecurityStepSha256.windowsAuthenticode,
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

function securityEnclosureViolations(value: string, signer: Uint8Array) {
  const workflow = parse(value)
  const windows = workflow.jobs["package-windows"].steps ?? []
  const windowsPreflight = windows.find((step) => step.name === "Preflight protected Windows signing identity")
  const azure = windows.find((step) => step.name === "Establish Azure CLI OIDC session")
  const authenticode = windows.find((step) => step.name === "Verify Authenticode publisher and trusted timestamp")
  const expectedAzure = {
    name: "Establish Azure CLI OIDC session",
    uses: azureLogin,
    with: {
      "client-id": "${{ secrets.AZURE_CLIENT_ID }}",
      "tenant-id": "${{ secrets.AZURE_TENANT_ID }}",
      "subscription-id": "${{ secrets.AZURE_SUBSCRIPTION_ID }}",
    },
  }
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
    ["Windows preflight", windowsPreflight?.run ?? "", reviewedSecurityEnclosureSha256.windowsPreflight],
    ["Authenticode", authenticode?.run ?? "", reviewedSecurityEnclosureSha256.windowsAuthenticode],
  ] as const
  return [
    ...closedSecurityStepViolations(value),
    ...digestEntries.flatMap(([name, run, expected]) => (sha256(run) === expected ? [] : [`${name} digest`])),
    ...(sha256(signer) === reviewedSecurityEnclosureSha256.windowsSigner ? [] : ["Windows signer digest"]),
    ...(JSON.stringify(azure) === JSON.stringify(expectedAzure) ? [] : ["closed Azure login"]),
    ...([windowsPreflight, azure, authenticode].every((step) => step && !("if" in step))
      ? []
      : ["disabled Windows security step"]),
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
    const packageRoot = resolve(root, "packages")
    const modules = resolve(packageRoot, "node_modules")
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
      const packageRoot = resolve("packages")
      const approvedDependencyRoot = realpathSync(resolve("packages/node_modules"))
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
    'const approvedDependencyRoot = realpathSync(resolve(workspaceRoot, "node_modules/.bun"))',
    'approvedDependencyRoot !== resolve(workspaceRoot, "node_modules/.bun")',
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

function windowsSigningViolations(value: string) {
  const job = parse(value).jobs["package-windows"]
  const steps = job.steps ?? []
  const preflight = steps.findIndex((step) => step.name === "Preflight protected Windows signing identity")
  const login = steps.findIndex((step) => step.name === "Establish Azure CLI OIDC session")
  const install = steps.findIndex((step) => step.name === "Install exact dependencies and stage WSL runtime")
  const build = steps.findIndex((step) => step.name === "Build signed Windows installer")
  const verify = steps.findIndex((step) => step.name === "Verify Authenticode publisher and trusted timestamp")
  const preflightRun = steps[preflight]?.run ?? ""
  const verifyRun = steps[verify]?.run ?? ""
  const required = [
    "AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}",
    "AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}",
    "AZURE_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}",
    "AZURE_TRUSTED_SIGNING_ENDPOINT: ${{ secrets.AZURE_TRUSTED_SIGNING_ENDPOINT }}",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME }}",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: ${{ secrets.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE }}",
    "EXPECTED_WINDOWS_PUBLISHER: ${{ vars.BHARATCODE_WINDOWS_PUBLISHER_SUBJECT }}",
    azureLogin,
    "client-id: ${{ secrets.AZURE_CLIENT_ID }}",
    "tenant-id: ${{ secrets.AZURE_TENANT_ID }}",
    "subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}",
  ]
  const requiredPreflight = [
    "const names = [",
    '"AZURE_CLIENT_ID"',
    '"AZURE_TENANT_ID"',
    '"AZURE_SUBSCRIPTION_ID"',
    '"AZURE_TRUSTED_SIGNING_ENDPOINT"',
    '"AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"',
    '"AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE"',
    '"EXPECTED_WINDOWS_PUBLISHER"',
    "value.trim() !== value",
    'value.includes("\\n")',
    'value.includes("\\r")',
    "/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/",
    "/^https:\\/\\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.codesigning\\.azure\\.net\\/$/",
    "/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/",
    "/^[A-Za-z0-9][A-Za-z0-9 .,()&=+-]{0,255}$/",
    'throw new Error("protected Windows signing input is missing or malformed")',
  ]
  const requiredVerification = [
    '$signature.Status -ne "Valid"',
    "$signature.SignerCertificate.Subject -cne $env:EXPECTED_WINDOWS_PUBLISHER",
    "-not $signature.TimeStamperCertificate",
    "[string]::IsNullOrWhiteSpace($signature.TimeStamperCertificate.Thumbprint)",
  ]
  return [
    ...(job.permissions?.["id-token"] === "write" ? [] : ["id-token"]),
    ...required.filter((fragment) => !value.includes(fragment)),
    ...requiredPreflight.filter((fragment) => !preflightRun.includes(fragment)),
    ...requiredVerification.filter((fragment) => !verifyRun.includes(fragment)),
    ...(preflight >= 0 && login === preflight + 1 && login < install && install < build && build < verify
      ? []
      : ["ordering"]),
    ...(steps[preflight]?.if === undefined && steps[login]?.if === undefined && steps[verify]?.if === undefined
      ? []
      : ["disabled signing step"]),
    ...(/(?:^|\n)\s*(?:exit|return)\b/iu.test(preflightRun) ? ["preflight early exit"] : []),
    ...(/(?:^|\n)\s*(?:exit|return)\b/iu.test(verifyRun) ? ["verification early exit"] : []),
  ]
}

const cliOnlyCredentialContract = [
  "ExcludeEnvironmentCredential     = $true",
  "ExcludeWorkloadIdentityCredential = $true",
  "ExcludeManagedIdentityCredential = $true",
  "ExcludeSharedTokenCacheCredential = $true",
  "ExcludeVisualStudioCredential    = $true",
  "ExcludeVisualStudioCodeCredential = $true",
  "ExcludeAzureCliCredential        = $false",
  "ExcludeAzurePowerShellCredential = $true",
  "ExcludeAzureDeveloperCliCredential = $true",
  "ExcludeInteractiveBrowserCredential = $true",
  "Invoke-TrustedSigning @params",
]

function windowsSignerViolations(value: string) {
  const active = value
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
  let depth = 0
  let topLevelExit = false
  for (const line of active.split("\n")) {
    const trimmed = line.trim()
    if (depth === 0 && /^(?:exit|return)\b/iu.test(trimmed)) topLevelExit = true
    depth += (line.match(/\{/gu)?.length ?? 0) - (line.match(/\}/gu)?.length ?? 0)
  }
  return [
    ...cliOnlyCredentialContract.filter((fragment) => !active.split("\n").some((line) => line.trim() === fragment)),
    ...(topLevelExit ? ["top-level signer exit"] : []),
    ...(active.indexOf("$params = @{") < active.indexOf("Invoke-TrustedSigning @params") ? [] : ["signer ordering"]),
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
    expect(new Set(actionUses)).toEqual(new Set([checkout, setupBun, upload, download, attest, azureLogin]))
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

  test("establishes the one Azure CLI OIDC path from closed protected Windows signing inputs", async () => {
    const value = await source()
    const script = bunEvalScripts(runStep(value, "package-windows", "Preflight protected Windows signing identity"))[0]
    expect(script).toBeDefined()
    const valid = {
      AZURE_CLIENT_ID: "12345678-1234-1234-1234-1234567890ab",
      AZURE_TENANT_ID: "22345678-1234-1234-1234-1234567890ab",
      AZURE_SUBSCRIPTION_ID: "32345678-1234-1234-1234-1234567890ab",
      AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
      AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "bharatcode-signing",
      AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: "desktop-beta",
      EXPECTED_WINDOWS_PUBLISHER: "CN=BharatCode, O=BharatCode",
    }
    const validate = (overrides: Record<string, string | undefined>) => {
      const env: Record<string, string | undefined> = { ...Bun.env, ...valid }
      for (const [name, item] of Object.entries(overrides)) {
        if (item === undefined) delete env[name]
        else env[name] = item
      }
      return Bun.spawnSync(["bun", "--eval", script], { env, stdout: "pipe", stderr: "pipe" })
    }
    expect(validate({}).exitCode).toBe(0)
    for (const [name, hostile] of [
      ["AZURE_CLIENT_ID", undefined],
      ["AZURE_CLIENT_ID", ""],
      ["AZURE_CLIENT_ID", " 12345678-1234-1234-1234-1234567890ab"],
      ["AZURE_CLIENT_ID", "12345678-1234-1234-1234-1234567890AB"],
      ["AZURE_CLIENT_ID", "12345678-1234-1234-1234-1234567890ab\n"],
      ["AZURE_CLIENT_ID", "not-a-uuid"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "http://eus.codesigning.azure.net/"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://user@eus.codesigning.azure.net/"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://eus.codesigning.azure.net/path"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://eus.codesigning.azure.net/?query=1"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://eus.codesigning.azure.net/#hash"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://eus.codesigning.azure.net.evil/"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://eus.codesigning.azure.net:444/"],
      ["AZURE_TRUSTED_SIGNING_ACCOUNT_NAME", "unsafe/account"],
      ["AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE", "unsafe profile"],
      ["EXPECTED_WINDOWS_PUBLISHER", "CN=BharatCode\nCN=Alternate"],
      ["EXPECTED_WINDOWS_PUBLISHER", "CN=BharatCode; Invoke-Evil"],
    ] as const) {
      const result = validate({ [name]: hostile })
      expect(result.exitCode).not.toBe(0)
      if (hostile) expect(result.stderr.toString()).not.toContain(hostile)
    }
    expect(windowsSigningViolations(value)).toEqual([])
    for (const [current, hostile] of [
      ["id-token: write", "id-token: none"],
      [azureLogin, "azure/login@v3"],
      ["client-id: ${{ secrets.AZURE_CLIENT_ID }}", "client-id: missing"],
      ["value.trim() !== value", "false"],
      ["Establish Azure CLI OIDC session", "Install Azure CLI session later"],
      ["$signature.SignerCertificate.Subject -cne $env:EXPECTED_WINDOWS_PUBLISHER", "false"],
      ["-not $signature.TimeStamperCertificate", "false"],
    ]) {
      expect(windowsSigningViolations(value.replaceAll(current, hostile))).not.toEqual([])
    }
    const signerFile = Bun.file(resolve(import.meta.dir, "../../../../script/sign-windows.ps1"))
    const signerBytes = new Uint8Array(await signerFile.arrayBuffer())
    for (const step of [
      "Preflight protected Windows signing identity",
      "Establish Azure CLI OIDC session",
      "Verify Authenticode publisher and trusted timestamp",
    ]) {
      const disabled = value.replace("      - name: " + step, "      - name: " + step + "\n        if: ${{ false }}")
      expect(windowsSigningViolations(disabled)).not.toEqual([])
      expect(securityEnclosureViolations(disabled, signerBytes)).toContain("disabled Windows security step")
    }
    expect(
      windowsSigningViolations(
        value.replace(
          "$signature = Get-AuthenticodeSignature bharatcode-desktop-next-beta-win-x64.exe",
          "exit 0\n          $signature = Get-AuthenticodeSignature bharatcode-desktop-next-beta-win-x64.exe",
        ),
      ),
    ).not.toEqual([])
    for (const name of Object.keys(valid)) {
      const violations = windowsSigningViolations(value.replace(name + ": ${{", "MISSING_INPUT: ${{"))
      if (violations.length === 0) throw new Error(`uncovered protected Windows input mutation: ${name}`)
    }
    const signer = Buffer.from(signerBytes).toString("utf8")
    expect(securityEnclosureViolations(value, signerBytes)).toEqual([])
    for (const [label, hostile] of [
      [
        "native preflight",
        value.replace(
          "      - name: Preflight exact cross-platform native dependencies\n        shell: bash",
          "      - name: Preflight exact cross-platform native dependencies\n        continue-on-error: true\n        shell: bash",
        ),
      ],
      [
        "native preflight",
        value.replace(
          "      - name: Preflight exact cross-platform native dependencies\n        shell: bash",
          "      - name: Preflight exact cross-platform native dependencies\n        shell: custom-security-shell",
        ),
      ],
      [
        "native preflight",
        value.replace(
          "      - name: Preflight exact cross-platform native dependencies\n        shell: bash",
          "      - name: Preflight exact cross-platform native dependencies\n        security-review-drift: true\n        shell: bash",
        ),
      ],
      [
        "Authenticode",
        value.replace(
          "      - name: Verify Authenticode publisher and trusted timestamp\n        shell: pwsh",
          "      - name: Verify Authenticode publisher and trusted timestamp\n        continue-on-error: true\n        shell: pwsh",
        ),
      ],
      [
        "Authenticode",
        value.replace(
          "      - name: Verify Authenticode publisher and trusted timestamp\n        shell: pwsh",
          "      - name: Verify Authenticode publisher and trusted timestamp\n        shell: custom-security-shell",
        ),
      ],
      [
        "Authenticode",
        value.replace(
          "      - name: Verify Authenticode publisher and trusted timestamp\n        shell: pwsh",
          "      - name: Verify Authenticode publisher and trusted timestamp\n        security-review-drift: true\n        shell: pwsh",
        ),
      ],
    ] as const) {
      expect(closedSecurityStepViolations(hostile).some((item) => item.startsWith(label))).toBeTrue()
    }
    for (const hostile of [
      value.replace(
        "            const payloads = {",
        '            globalThis.process["exit"](0)\n            const payloads = {',
      ),
      value
        .replace(
          '          bun --eval \'\n            import { realpathSync } from "node:fs"',
          '          if ! true; then\n          bun --eval \'\n            import { realpathSync } from "node:fs"',
        )
        .replace(
          "          '\n\n      - name: Prove dependency install kept exact build inputs clean",
          "          '\n          fi\n\n      - name: Prove dependency install kept exact build inputs clean",
        ),
      value
        .replace(
          "          bun --eval '\n            const names = [",
          "          if ($false) {\n          bun --eval '\n            const names = [",
        )
        .replace(
          "          '\n\n      - name: Establish Azure CLI OIDC session",
          "          '\n          }\n\n      - name: Establish Azure CLI OIDC session",
        ),
      value
        .replace(
          "          $signature = Get-AuthenticodeSignature bharatcode-desktop-next-beta-win-x64.exe",
          "          if ($false) {\n          $signature = Get-AuthenticodeSignature bharatcode-desktop-next-beta-win-x64.exe",
        )
        .replace(
          "          if ([version]$version -ne [version]'${{ needs.admit-source.outputs.desktop_version }}') { throw \"Windows package version drift\" }\n\n      - name: Attest Windows installer",
          "          if ([version]$version -ne [version]'${{ needs.admit-source.outputs.desktop_version }}') { throw \"Windows package version drift\" }\n          }\n\n      - name: Attest Windows installer",
        ),
      value.replace(
        "          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}",
        "          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}\n          audience: api://hostile",
      ),
    ]) {
      expect(securityEnclosureViolations(hostile, signerBytes)).not.toEqual([])
    }
    const unreachableSigner = signer
      .replace("$params = @{", "if ($false) {\n$params = @{")
      .replace("Invoke-TrustedSigning @params", "Invoke-TrustedSigning @params\n}")
    expect(securityEnclosureViolations(value, Buffer.from(unreachableSigner))).toContain("Windows signer digest")
    expect(windowsSignerViolations(signer)).toEqual([])
    for (const required of cliOnlyCredentialContract) {
      expect(windowsSignerViolations(signer.replace(required, "removed"))).not.toEqual([])
      expect(windowsSignerViolations(signer.replace(required, `# ${required}`))).not.toEqual([])
    }
    expect(windowsSignerViolations(signer.replace("$params = @{", "exit 0\n$params = @{"))).not.toEqual([])
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
