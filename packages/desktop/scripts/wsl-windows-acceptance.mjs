#!/usr/bin/env node
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const receiptFilename = "scenarios-9-10.json"
const digestFilename = `${receiptFilename}.sha256`
const argumentNames = new Map([
  ["--desktop-exe", "desktopExe"],
  ["--runtime-manifest", "runtimeManifest"],
  ["--distribution", "distribution"],
  ["--invalid-distribution", "invalidDistribution"],
  ["--missing-prerequisite-distribution", "missingPrerequisiteDistribution"],
  ["--windows-project", "windowsProject"],
  ["--source-sha", "sourceSha"],
  ["--acceptance-dir", "acceptanceDirectory"],
])
const observationKeys = [
  "schema",
  "case",
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
  "checks",
]
const scenarioChecks = {
  "scenario-9": [
    "authenticated_loopback",
    "inside_selected_distro",
    "non_root",
    "packaged_desktop",
    "packaged_runtime",
    "project_round_trip",
    "source_identity",
    "storage_inside_distro",
    "unauthenticated_rejected",
  ],
  "scenario-10": [
    "credentials_main_only",
    "desktop_restart",
    "harness_processes_gone",
    "invalid_distribution_recovery",
    "missing_prerequisite_recovery",
    "one_reconnect",
    "ordinary_stop",
    "repeated_crash_visible",
    "restart",
    "unrelated_process_preserved",
  ],
}
const childEnvironmentKeys = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]

export function acceptanceChildEnvironment(environment) {
  return Object.fromEntries(
    childEnvironmentKeys.flatMap((name) => {
      const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      const value = key ? environment[key] : undefined
      return typeof value === "string" && value ? [[name, value]] : []
    }),
  )
}

export function parseAcceptanceArguments(argv) {
  if (argv.length !== argumentNames.size * 2) throw new Error("Acceptance CLI requires the exact argument set")
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argumentNames.get(argv[index])
    const value = argv[index + 1]
    if (!key || typeof value !== "string" || !value || Object.hasOwn(result, key)) {
      throw new Error("Acceptance CLI contains an unknown, duplicate, missing, or positional argument")
    }
    if (/\0|\r|\n/u.test(value)) throw new Error("Acceptance CLI arguments must be single-line values")
    result[key] = value
  }
  if (Object.keys(result).length !== argumentNames.size) throw new Error("Acceptance CLI is incomplete")
  if (!/^[0-9a-f]{40}$/u.test(result.sourceSha)) throw new Error("Source SHA must be exact lowercase 40-hex")
  for (const value of [result.distribution, result.invalidDistribution, result.missingPrerequisiteDistribution]) {
    if (!safeDisplayName(value)) throw new Error("Acceptance distribution name is invalid")
  }
  if (new Set([result.distribution, result.invalidDistribution, result.missingPrerequisiteDistribution]).size !== 3) {
    throw new Error("Acceptance distributions must be distinct")
  }
  if (
    !/^[A-Za-z]:\\/u.test(result.windowsProject) ||
    win32.normalize(result.windowsProject) !== result.windowsProject
  ) {
    throw new Error("Windows project must be a canonical absolute drive path")
  }
  return result
}

export function parseAcceptanceObservation(value) {
  if (!exactRecord(value, observationKeys)) throw new Error("Acceptance observation must use the closed schema")
  if (value.schema !== "bharatcode-wsl-packaged-case-v1" || !Object.hasOwn(scenarioChecks, value.case)) {
    throw new Error("Acceptance observation schema or case is invalid")
  }
  for (const field of [
    "desktop_sha256",
    "runtime_manifest_sha256",
    "manifest_runtime_sha256",
    "executed_runtime_sha256",
    "distro_sha256",
    "user_sha256",
  ]) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/u.test(value[field])) {
      throw new Error(`Acceptance observation ${field} must be exact lowercase SHA-256`)
    }
  }
  for (const field of ["source_sha", "manifest_source_sha", "executed_source_sha"]) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]{40}$/u.test(value[field])) {
      throw new Error(`Acceptance observation ${field} must be exact lowercase source SHA`)
    }
  }
  if (!Number.isSafeInteger(value.uid) || value.uid <= 0) throw new Error("Acceptance UID must be non-root")
  if (value.wsl_version !== 2) throw new Error("Acceptance observation must prove WSL2")
  if (
    !exactRecord(value.checks, scenarioChecks[value.case]) ||
    Object.values(value.checks).some((item) => item !== true)
  ) {
    throw new Error("Acceptance observation is incomplete")
  }
  return value
}

export async function runWindowsAcceptance(argv, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("Packaged WSL acceptance requires Windows")
  }
  const input = parseAcceptanceArguments(argv)
  const authority = githubAuthority(dependencies.env ?? process.env)
  const acceptanceDirectory = resolve(input.acceptanceDirectory)
  const receiptPath = join(acceptanceDirectory, receiptFilename)
  const digestPath = join(acceptanceDirectory, digestFilename)
  const artifacts = await verifyPackagedInputs({
    desktopExe: resolve(input.desktopExe),
    runtimeManifest: resolve(input.runtimeManifest),
    sourceSha: input.sourceSha,
  })
  await ensureAcceptanceDirectory(acceptanceDirectory)
  if ((await exists(receiptPath)) || (await exists(digestPath))) {
    throw new Error("Acceptance receipt or digest already exists")
  }
  if ((await (dependencies.verifyWindowsProject ?? verifyWindowsProject)(input.windowsProject)) !== true) {
    throw new Error("Windows acceptance project was not positively verified")
  }
  const distributions = await (dependencies.inspectWsl ?? inspectWslDistributions)()
  if (
    !Array.isArray(distributions) ||
    distributions.some(
      (item) =>
        !exactRecord(item, ["displayName", "version"]) ||
        !safeDisplayName(item.displayName) ||
        !Number.isSafeInteger(item.version),
    )
  ) {
    throw new Error("WSL inventory is malformed")
  }
  for (const displayName of [input.distribution, input.invalidDistribution, input.missingPrerequisiteDistribution]) {
    const matches = distributions.filter((item) => item.displayName === displayName)
    if (matches.length !== 1 || matches[0].version !== 2) {
      throw new Error(`Acceptance requires exactly one WSL2 instance named: ${displayName}`)
    }
  }

  const caseInput = {
    desktopExe: artifacts.desktopExe,
    runtimeManifest: artifacts.runtimeManifest,
    distribution: input.distribution,
    invalidDistribution: input.invalidDistribution,
    missingPrerequisiteDistribution: input.missingPrerequisiteDistribution,
    windowsProject: input.windowsProject,
    sourceSha: input.sourceSha,
  }
  const runCase = dependencies.runCase ?? runExecutableCase
  const scenario9 = parseAcceptanceObservation(await runCase({ ...caseInput, case: "scenario-9" }))
  const scenario10 = parseAcceptanceObservation(await runCase({ ...caseInput, case: "scenario-10" }))
  verifyObservationIdentity(scenario9, artifacts, input)
  verifyObservationIdentity(scenario10, artifacts, input)
  if (!sameObservationIdentity(scenario9, scenario10)) throw new Error("Acceptance case identity mismatch")

  if (!authority) return { authority: "DIAGNOSTIC", receiptPath: undefined, digestPath: undefined }
  const receipt = {
    schema: "bharatcode-wsl-scenarios-9-10-v1",
    result: "PASS",
    source_sha: input.sourceSha,
    desktop_sha256: artifacts.desktopSha256,
    runtime_manifest_sha256: artifacts.manifestSha256,
    runtime: {
      manifest_source_sha: scenario9.manifest_source_sha,
      executed_source_sha: scenario9.executed_source_sha,
      manifest_sha256: scenario9.manifest_runtime_sha256,
      executed_sha256: scenario9.executed_runtime_sha256,
    },
    github: authority,
    identity: {
      distro_sha256: scenario9.distro_sha256,
      user_sha256: scenario9.user_sha256,
      uid: scenario9.uid,
    },
    scenarios: { 9: true, 10: true },
    completed_at: (dependencies.now ?? (() => new Date()))().toISOString(),
  }
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  await writeCreateOnly(
    digestPath,
    Buffer.from(`${createHash("sha256").update(receiptBytes).digest("hex")}  ${receiptFilename}\n`),
  )
  await writeCreateOnly(receiptPath, receiptBytes)
  return { authority: "PASS", receiptPath, digestPath }
}

async function verifyPackagedInputs(input) {
  if (basename(input.desktopExe).toLowerCase().endsWith(".exe") !== true) {
    throw new Error("Packaged Desktop must be a Windows executable")
  }
  const desktop = await readImmutableFile(input.desktopExe, "Packaged Desktop")
  if (
    desktop.length < 4 ||
    desktop.subarray(0, 2).toString("ascii") !== "MZ" ||
    !desktop.includes(Buffer.from("PE\0\0"))
  ) {
    throw new Error("Packaged Desktop is not a PE executable")
  }
  const manifestBytes = await readImmutableFile(input.runtimeManifest, "Packaged runtime manifest")
  const manifest = parseCanonicalManifest(manifestBytes)
  if (manifest.source_sha !== input.sourceSha) throw new Error("Packaged runtime source mismatch")
  const runtimePath = join(dirname(input.runtimeManifest), manifest.filename)
  const runtime = await readImmutableFile(runtimePath, "Packaged runtime")
  if (runtime.length !== manifest.bytes || createHash("sha256").update(runtime).digest("hex") !== manifest.sha256) {
    throw new Error("Packaged runtime digest mismatch")
  }
  return {
    desktopExe: input.desktopExe,
    runtimeManifest: input.runtimeManifest,
    desktopSha256: createHash("sha256").update(desktop).digest("hex"),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    runtimeSha256: manifest.sha256,
  }
}

function parseCanonicalManifest(bytes) {
  let value
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Packaged runtime manifest is not valid JSON")
  }
  const keys = ["schema", "source_sha", "version", "arch", "filename", "bytes", "sha256"]
  if (!exactRecord(value, keys) || bytes.toString("utf8") !== `${JSON.stringify(value)}\n`) {
    throw new Error("Packaged runtime manifest must be canonical and closed")
  }
  if (value.schema !== 1 || !/^[0-9a-f]{40}$/u.test(value.source_sha)) throw new Error("Invalid manifest source")
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version)) {
    throw new Error("Invalid manifest version")
  }
  if (value.arch !== "x64" && value.arch !== "arm64") throw new Error("Invalid manifest architecture")
  if (value.filename !== `bharatcode-runtime-linux-${value.arch}-glibc`) throw new Error("Invalid manifest filename")
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error("Invalid manifest byte count")
  if (!/^[0-9a-f]{64}$/u.test(value.sha256)) throw new Error("Invalid manifest digest")
  return value
}

async function readImmutableFile(path, label) {
  const before = await lstat(path).catch(() => {
    throw new Error(`${label} is missing`)
  })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o222) !== 0) {
    throw new Error(`${label} must be an immutable regular non-symlink file`)
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!sameFile(before, opened)) throw new Error(`${label} changed before verification`)
    const bytes = await handle.readFile()
    if (!sameFile(opened, await handle.stat())) throw new Error(`${label} changed during verification`)
    return bytes
  } finally {
    await handle.close()
  }
}

function sameFile(left, right) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink"].every((key) => left[key] === right[key])
}

async function ensureAcceptanceDirectory(path) {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Acceptance directory must be a local non-symlink directory")
}

async function verifyWindowsProject(path) {
  const info = await lstat(path).catch(() => {
    throw new Error("Windows acceptance project is missing")
  })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Windows acceptance project must be a non-symlink directory")
  return true
}

async function inspectWslDistributions() {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || /\0|\r|\n/u.test(systemRoot)) throw new Error("Trusted Windows SystemRoot is unavailable")
  const executable = join(systemRoot, "System32", "wsl.exe")
  const [quiet, verbose] = await Promise.all([
    execFileAsync(executable, ["--list", "--quiet"], {
      windowsHide: true,
      shell: false,
      encoding: "buffer",
      env: acceptanceChildEnvironment(process.env),
    }),
    execFileAsync(executable, ["--list", "--verbose"], {
      windowsHide: true,
      shell: false,
      encoding: "buffer",
      env: acceptanceChildEnvironment(process.env),
    }),
  ])
  const names = decodeWslOutput(quiet.stdout)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
  const rows = decodeWslOutput(verbose.stdout)
    .split("\n")
    .map((item) => item.replace(/^\s*\*?\s*/u, "").trim())
    .filter(Boolean)
  return names.map((displayName) => {
    const matches = rows.flatMap((row) => {
      const version = row.match(/\s([0-9]+)\s*$/u)
      if (!version || !row.startsWith(displayName) || !/^\s/u.test(row.slice(displayName.length))) return []
      return [Number(version[1])]
    })
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0]))
      throw new Error("WSL distribution version is ambiguous")
    return { displayName, version: matches[0] }
  })
}

function decodeWslOutput(value) {
  const bytes = Buffer.from(value)
  const text =
    bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString("utf16le")
      : bytes.toString("utf8")
  return text
    .replace(/^\uFEFF/u, "")
    .replaceAll("\0", "")
    .replaceAll("\r\n", "\n")
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
  if (result.stderr) throw new Error("Packaged acceptance case wrote stderr")
  const line = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout
  if (!line || /\r|\n/u.test(line) || Buffer.byteLength(line) > 8_192) {
    throw new Error("Packaged acceptance case output is not one bounded JSON record")
  }
  const value = JSON.parse(line)
  if (line !== JSON.stringify(value)) throw new Error("Packaged acceptance case output must be canonical JSON")
  return value
}

function verifyObservationIdentity(observation, artifacts, input) {
  const expectedDistro = createHash("sha256").update(input.distribution).digest("hex")
  if (
    observation.source_sha !== input.sourceSha ||
    observation.manifest_source_sha !== input.sourceSha ||
    observation.executed_source_sha !== input.sourceSha ||
    observation.desktop_sha256 !== artifacts.desktopSha256 ||
    observation.runtime_manifest_sha256 !== artifacts.manifestSha256 ||
    observation.manifest_runtime_sha256 !== artifacts.runtimeSha256 ||
    observation.executed_runtime_sha256 !== artifacts.runtimeSha256 ||
    observation.distro_sha256 !== expectedDistro
  ) {
    throw new Error("Acceptance observation identity mismatch")
  }
}

function sameObservationIdentity(left, right) {
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

function githubAuthority(env) {
  if (env.GITHUB_ACTIONS !== "true") return undefined
  if (env.RUNNER_OS !== "Windows") throw new Error("Authoritative acceptance requires RUNNER_OS=Windows")
  return {
    run_id: positiveCanonicalInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    run_attempt: positiveCanonicalInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
  }
}

function positiveCanonicalInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value))
    throw new Error(`${label} must be a positive canonical integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`)
  return parsed
}

async function writeCreateOnly(path, bytes) {
  const handle = await open(path, "wx", 0o444)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function exactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function safeDisplayName(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length <= 128 &&
    !value.startsWith("-") &&
    !/[\0-\x1f\x7f/\\]/u.test(value)
  )
}

async function exists(path) {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  runWindowsAcceptance(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${result.authority}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
