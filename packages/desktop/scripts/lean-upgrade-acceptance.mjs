#!/usr/bin/env node
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"

import {
  canonicalLeanJson,
  parseCurrentBetaFixtureBytes,
  parseLeanUpgradeReceiptBytes,
} from "./lean-upgrade-receipt.mjs"

const RECEIPT_FILENAME = "upgrade-rollback-windows-x64.json"
const CANDIDATE_FILENAME = "bharatcode-desktop-next-beta-win-x64.exe"
const INSTALLED_EXECUTABLE = "bharatcode-beta.exe"
const PROCESS_TIMEOUT_MS = 300_000
const STARTUP_TIMEOUT_MS = 120_000
const MAX_PROCESS_OUTPUT = 1_048_576
const argumentNames = new Map([
  ["--fixture", "fixture"],
  ["--candidate", "candidate"],
  ["--source-sha", "sourceSha"],
  ["--acceptance-dir", "acceptanceDirectory"],
])
const checkKeys = [
  "bharatcode_runtime_only",
  "candidate_installed_over_beta",
  "candidate_started",
  "current_beta_download_verified",
  "current_beta_installed_and_started",
  "eligible_state_preserved",
  "eligible_state_seeded",
  "migration_source_preserved",
  "recovery_evidence_preserved",
  "rollback_installed",
  "rollback_state_structurally_valid",
  "share_network_attempt_absent",
  "sharenext_absent",
]
const childEnvironmentKeys = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]

export function parseUpgradeAcceptanceArguments(argv) {
  if (argv.length !== argumentNames.size * 2) throw new Error("Upgrade acceptance requires the exact argument set")
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argumentNames.get(argv[index])
    const value = argv[index + 1]
    if (!key || typeof value !== "string" || !value || Object.hasOwn(result, key) || /[\0\r\n]/u.test(value)) {
      throw new Error("Upgrade acceptance contains an unknown, duplicate, missing, or positional argument")
    }
    result[key] = value
  }
  if (Object.keys(result).length !== argumentNames.size) throw new Error("Upgrade acceptance arguments are incomplete")
  if (!/^[0-9a-f]{40}$/u.test(result.sourceSha) || result.sourceSha === "0".repeat(40)) {
    throw new Error("Upgrade acceptance source must be exact nonzero 40-hex")
  }
  if (basename(result.candidate) !== CANDIDATE_FILENAME)
    throw new Error("Upgrade acceptance candidate filename is invalid")
  return {
    fixture: resolve(result.fixture),
    candidate: resolve(result.candidate),
    sourceSha: result.sourceSha,
    acceptanceDirectory: resolve(result.acceptanceDirectory),
  }
}

export function validateCurrentBetaApiObservation(value, fixture) {
  requireRecord(value, ["asset", "release", "tag_commit_sha"], "current-beta API observation")
  const expectedAsset = fixture.assets[0]
  const releaseUrl = `https://api.github.com/repos/${fixture.repository}/releases/${fixture.release_id}`
  const assetUrl = `https://api.github.com/repos/${fixture.repository}/releases/assets/${expectedAsset.asset_id}`
  requireValue(value.release?.id === Number(fixture.release_id), "current-beta release ID changed")
  requireValue(value.release?.tag_name === fixture.tag, "current-beta release tag changed")
  requireValue(value.release?.url === releaseUrl, "current-beta repository or release URL changed")
  requireValue(value.release?.assets_url === `${releaseUrl}/assets`, "current-beta release assets URL changed")
  requireValue(Array.isArray(value.release?.assets), "current-beta release asset inventory is invalid")
  const selected = value.release.assets.filter(
    (asset) => asset?.id === Number(expectedAsset.asset_id) || asset?.name === expectedAsset.filename,
  )
  requireValue(selected.length === 1, "current-beta selected asset identity is missing, duplicated, or ambiguous")
  validateRemoteAsset(selected[0], expectedAsset, assetUrl, "current-beta selected release asset")
  validateRemoteAsset(value.asset, expectedAsset, assetUrl, "current-beta asset metadata")
  requireValue(value.tag_commit_sha === fixture.source_sha, "current-beta tag source changed")
  return structuredClone(value)
}

export function validateUpgradeExecutionObservation(value) {
  requireRecord(value, ["candidate", "checks", "cleanup_complete", "schema"], "packaged upgrade execution observation")
  requireValue(
    value.schema === "bharatcode-packaged-upgrade-observation-v1",
    "packaged upgrade execution schema is invalid",
  )
  validateCandidate(value.candidate)
  requireRecord(value.checks, checkKeys, "packaged upgrade execution checks")
  requireValue(
    Object.values(value.checks).every((item) => item === true),
    "packaged upgrade execution, ShareNext, network, rollback, or cleanup checks failed",
  )
  requireValue(value.cleanup_complete === true, "packaged upgrade process cleanup is incomplete")
  requireValue(!containsSecretLikeValue(value), "packaged upgrade observation contains a secret-like value")
  return structuredClone(value)
}

export async function verifyPinnedInstaller(path, expected) {
  const bytes = await readStableFile(path, "pinned installer")
  requirePe(bytes, "pinned installer")
  requireValue(basename(path) === expected.filename, "pinned installer filename changed")
  requireValue(bytes.byteLength === expected.bytes, "pinned installer byte size changed")
  requireValue(digest(bytes) === expected.sha256, "pinned installer SHA-256 changed")
  return structuredClone(expected)
}

export async function runLeanUpgradeAcceptance(argv, dependencies) {
  const input = parseUpgradeAcceptanceArguments(argv)
  const runtime = dependencies ?? {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    now: () => new Date(),
    execute: executeProductionAcceptance,
  }
  if (runtime.platform !== "win32" || runtime.arch !== "x64") {
    throw new Error("Packaged upgrade acceptance requires a real Windows x64 host")
  }
  const authority = githubAuthority(runtime.env)
  const currentBeta = parseCurrentBetaFixtureBytes(new Uint8Array(await readFile(input.fixture)))
  await createAcceptanceDirectory(input.acceptanceDirectory)
  const receiptPath = join(input.acceptanceDirectory, RECEIPT_FILENAME)
  const observation = validateUpgradeExecutionObservation(
    await runtime.execute({
      ...input,
      currentBeta,
      authority,
      environment: runtime.env,
    }),
  )
  if (dependencies) return { authority: "DIAGNOSTIC", receiptPath: undefined }
  const receipt = {
    schema: "bharatcode-lean-upgrade-rollback-receipt-v1",
    result: "PASS",
    repository: currentBeta.repository,
    source_sha: input.sourceSha,
    candidate_tag: `next-beta-${input.sourceSha.slice(0, 12)}`,
    github: { run_id: authority.run_id, run_attempt: authority.run_attempt },
    host: { os: "windows", arch: "x64", runner_image: authority.runner_image },
    current_beta: {
      release_id: currentBeta.release_id,
      tag: currentBeta.tag,
      source_sha: currentBeta.source_sha,
      asset: currentBeta.assets[0],
    },
    candidate: observation.candidate,
    checks: observation.checks,
    completed_at: runtime.now().toISOString(),
  }
  const bytes = Buffer.from(canonicalLeanJson(receipt))
  parseLeanUpgradeReceiptBytes(bytes, {
    source_sha: input.sourceSha,
    run_id: authority.run_id,
    run_attempt: authority.run_attempt,
    current_beta: currentBeta,
    candidate: observation.candidate,
  })
  await writeCreateOnly(receiptPath, bytes)
  return { authority: "PASS", receiptPath }
}

async function executeProductionAcceptance(input) {
  const installDirectory = join(input.acceptanceDirectory, "installed")
  const profile = isolatedProfile(input.acceptanceDirectory, input.environment)
  const active = new Set()
  let cleanupComplete = false
  try {
    await initializeIsolatedProfile(profile)
    const prepared = await prepareProductionInputs(input)
    await verifyPinnedInstaller(prepared.betaInstaller, input.currentBeta.assets[0])
    const betaInstalled = await runInstaller(prepared.betaInstaller, installDirectory, profile.env)
    const betaStart = await startDesktop(installDirectory, profile, "current-beta", active)
    requireValue(betaStart.started && betaStart.cleanup_complete, "current-beta install or startup failed")
    const seeded = await seedEligibleState(profile, input.currentBeta.source_sha)
    await verifyPinnedInstaller(input.candidate, prepared.candidate)
    const candidateInstalled = await runInstaller(input.candidate, installDirectory, profile.env)
    requireValue(
      candidateInstalled.executable.sha256 !== betaInstalled.executable.sha256 &&
        candidateInstalled.inventory.sha256 !== betaInstalled.inventory.sha256,
      "candidate did not replace the beta installation",
    )
    await initializeRecoveryState(installDirectory, profile)
    const preserved = [...seeded, await captureRecoveryEvidence(profile)]
    const candidateStart = await startDesktop(installDirectory, profile, "candidate", active)
    requireValue(candidateStart.started && candidateStart.cleanup_complete, "candidate install or startup failed")
    const candidateState = await verifyEligibleState(preserved)
    const runtime = await verifyCandidateRuntime(installDirectory, profile)
    await verifyPinnedInstaller(prepared.betaInstaller, input.currentBeta.assets[0])
    const rollbackInstalled = await runInstaller(prepared.betaInstaller, installDirectory, profile.env)
    requireValue(
      rollbackInstalled.executable.bytes === betaInstalled.executable.bytes &&
        rollbackInstalled.executable.sha256 === betaInstalled.executable.sha256 &&
        rollbackInstalled.inventory.files === betaInstalled.inventory.files &&
        rollbackInstalled.inventory.sha256 === betaInstalled.inventory.sha256,
      "rollback did not restore the exact beta installation",
    )
    const rollbackStart = await startDesktop(installDirectory, profile, "rollback", active)
    requireValue(rollbackStart.started && rollbackStart.cleanup_complete, "rollback install or startup failed")
    const rollbackState = await verifyEligibleState(preserved)
    const shareNetworkAttemptAbsent = await verifyShareNetworkAbsence([
      betaStart.netLog,
      candidateStart.netLog,
      rollbackStart.netLog,
    ])
    cleanupComplete = await verifyNoOwnedProcesses(active)
    return {
      schema: "bharatcode-packaged-upgrade-observation-v1",
      candidate: prepared.candidate,
      checks: {
        current_beta_download_verified: true,
        current_beta_installed_and_started: true,
        eligible_state_seeded: true,
        candidate_installed_over_beta: true,
        eligible_state_preserved: candidateState.eligible,
        candidate_started: true,
        bharatcode_runtime_only: runtime.bharatcodeOnly,
        rollback_installed: true,
        rollback_state_structurally_valid: rollbackState.structurallyValid,
        migration_source_preserved: candidateState.migrationSource && rollbackState.migrationSource,
        recovery_evidence_preserved: candidateState.recoveryEvidence && rollbackState.recoveryEvidence,
        sharenext_absent: runtime.sharenextAbsent,
        share_network_attempt_absent: shareNetworkAttemptAbsent,
      },
      cleanup_complete: cleanupComplete,
    }
  } finally {
    if (!cleanupComplete && !(await terminateOwnedProcesses(active))) {
      throw new Error("Packaged upgrade process cleanup failed")
    }
  }
}

async function prepareProductionInputs(input) {
  const candidateBytes = await readStableFile(input.candidate, "candidate installer")
  requirePe(candidateBytes, "candidate installer")
  const candidate = {
    key: "desktop-windows-x64",
    filename: basename(input.candidate),
    bytes: candidateBytes.byteLength,
    sha256: digest(candidateBytes),
  }
  validateCandidate(candidate)
  const betaInstaller = join(input.acceptanceDirectory, input.currentBeta.assets[0].filename)
  await downloadCurrentBeta(input.currentBeta, betaInstaller)
  return { candidate, betaInstaller }
}

async function downloadCurrentBeta(fixture, destination) {
  const releaseUrl = `https://api.github.com/repos/${fixture.repository}/releases/${fixture.release_id}`
  const assetUrl = `https://api.github.com/repos/${fixture.repository}/releases/assets/${fixture.assets[0].asset_id}`
  const release = await fetchJson(releaseUrl)
  const asset = await fetchJson(assetUrl)
  const tagCommitSha = await resolveTagCommit(fixture)
  validateCurrentBetaApiObservation({ release, tag_commit_sha: tagCommitSha, asset }, fixture)
  const response = await fetch(assetUrl, { headers: githubHeaders("application/octet-stream"), redirect: "follow" })
  if (!response.ok) throw new Error(`Current-beta asset download failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const expected = fixture.assets[0]
  requireValue(bytes.byteLength === expected.bytes, "current-beta downloaded byte size changed")
  requireValue(digest(bytes) === expected.sha256, "current-beta downloaded SHA-256 changed")
  requirePe(bytes, "current-beta installer")
  await writeCreateOnly(destination, bytes)
}

async function resolveTagCommit(fixture) {
  const ref = await fetchJson(
    `https://api.github.com/repos/${fixture.repository}/git/ref/tags/${encodeURIComponent(fixture.tag)}`,
  )
  requireValue(ref?.ref === `refs/tags/${fixture.tag}`, "current-beta tag reference changed")
  if (ref.object?.type === "commit") return ref.object.sha
  requireValue(
    ref.object?.type === "tag" && /^[0-9a-f]{40}$/u.test(ref.object.sha),
    "current-beta tag object is invalid",
  )
  const tag = await fetchJson(`https://api.github.com/repos/${fixture.repository}/git/tags/${ref.object.sha}`)
  requireValue(tag?.object?.type === "commit", "current-beta annotated tag does not resolve to a commit")
  return tag.object.sha
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: githubHeaders("application/vnd.github+json"), redirect: "error" })
  if (!response.ok) throw new Error(`GitHub identity request failed with HTTP ${response.status}`)
  return response.json()
}

function githubHeaders(accept) {
  return {
    Accept: accept,
    "User-Agent": "bharatcode-packaged-upgrade-acceptance",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

async function runInstaller(installer, installDirectory, env) {
  await runProcess(installer, ["/S", `/D=${installDirectory}`], { env, timeout: PROCESS_TIMEOUT_MS })
  const executable = join(installDirectory, INSTALLED_EXECUTABLE)
  const bytes = await readStableFile(executable, "installed BharatCode executable")
  requirePe(bytes, "installed BharatCode executable")
  return {
    executable: { bytes: bytes.byteLength, sha256: digest(bytes) },
    inventory: await directoryIdentity(installDirectory),
  }
}

async function startDesktop(installDirectory, profile, phase, active) {
  const executable = join(installDirectory, INSTALLED_EXECUTABLE)
  const netLog = join(profile.netLogs, `${phase}.json`)
  const child = Bun.spawn(
    [executable, `--log-net-log=${netLog}`, "--net-log-capture-mode=Everything", "--disable-gpu"],
    {
      env: profile.env,
      cwd: installDirectory,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    },
  )
  active.add(child.pid)
  try {
    await waitForDesktopStartup(profile.userData, child, phase)
  } catch (error) {
    await terminateProcessTree(child.pid)
    active.delete(child.pid)
    throw error
  }
  const cleanupComplete = await terminateProcessTree(child.pid)
  active.delete(child.pid)
  requireValue(await Bun.file(netLog).exists(), "Desktop network observation is missing")
  return { started: true, cleanup_complete: cleanupComplete, netLog }
}

async function waitForDesktopStartup(userData, child, phase) {
  const startedAt = Date.now()
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const exited = await Promise.race([child.exited.then((code) => ({ code })), delay(500).then(() => undefined)])
    if (exited) throw new Error(`Desktop process exited before startup completed (${exited.code})`)
    const logs = await boundedTextFiles(join(userData, "logs"), startedAt)
    const started = logs.some((text) =>
      phase === "candidate"
        ? /init step.*(?:"phase"\s*:\s*"done"|phase[=: ]+done)/iu.test(text)
        : /app starting/iu.test(text),
    )
    if (!started) continue
    const exitedAfterStartup = await Promise.race([
      child.exited.then((code) => ({ code })),
      delay(2_000).then(() => undefined),
    ])
    if (exitedAfterStartup)
      throw new Error(`Desktop process exited during startup observation (${exitedAfterStartup.code})`)
    return
  }
  throw new Error("Desktop startup timed out")
}

async function seedEligibleState(profile, betaSourceSha) {
  const metadata = join(profile.data, "acceptance")
  const desktop = join(profile.userData, "acceptance-state")
  const paths = [
    [join(profile.config, "bharatcode.json"), { snapshot: false }],
    [
      join(metadata, "session.json"),
      { id: "ses_upgrade_acceptance", title: "Preserved local session", created_at: "2026-07-20T00:00:00.000Z" },
    ],
    [join(metadata, "account.json"), { state: "signed-out", label: "Local account metadata" }],
    [join(desktop, "migration-source.json"), { source_sha: betaSourceSha, state: "preserved" }],
  ]
  const snapshot = []
  for (const [path, value] of paths) {
    const bytes = Buffer.from(canonicalLeanJson(value))
    requireValue(!containsSecretLikeValue(value), "eligible state contains a secret-like value")
    await mkdir(dirname(path), { recursive: true })
    await writeCreateOnly(path, bytes)
    snapshot.push({ path, sha256: digest(bytes), bytes: bytes.byteLength })
  }
  return snapshot
}

async function captureRecoveryEvidence(profile) {
  const files = await stableFiles(profile.state)
  requireValue(files.length > 0, "candidate recovery initialization produced no evidence")
  const value = {
    schema: "bharatcode-recovery-evidence-v1",
    files: files.map((file) => ({
      path: relative(profile.state, file.path).replaceAll("\\", "/"),
      bytes: file.bytes.byteLength,
      sha256: digest(file.bytes),
    })),
  }
  requireValue(!containsSecretLikeValue(value), "recovery evidence contains a secret-like value")
  const path = join(profile.userData, "acceptance-state", "recovery-evidence.json")
  const bytes = Buffer.from(canonicalLeanJson(value))
  await writeCreateOnly(path, bytes)
  return { path, sha256: digest(bytes), bytes: bytes.byteLength }
}

async function verifyEligibleState(snapshot) {
  for (const expected of snapshot) {
    const bytes = await readStableFile(expected.path, "eligible preserved state")
    requireValue(bytes.byteLength === expected.bytes && digest(bytes) === expected.sha256, "eligible state changed")
    requireValue(
      !containsSecretLikeValue(JSON.parse(bytes.toString("utf8"))),
      "eligible state gained a secret-like value",
    )
  }
  return {
    eligible: true,
    structurallyValid: true,
    migrationSource: snapshot.some((item) => basename(item.path) === "migration-source.json"),
    recoveryEvidence: snapshot.some((item) => basename(item.path) === "recovery-evidence.json"),
  }
}

async function verifyCandidateRuntime(installDirectory, profile) {
  const runtime = join(installDirectory, "resources", "bharatcode-opencode-cli.exe")
  requirePe(await readStableFile(runtime, "packaged BharatCode runtime"), "packaged BharatCode runtime")
  const version = await runProcess(runtime, ["--version"], { env: profile.env, timeout: PROCESS_TIMEOUT_MS })
  const help = await runProcess(runtime, ["--help"], { env: profile.env, timeout: PROCESS_TIMEOUT_MS })
  const runHelp = await runProcess(runtime, ["run", "--help"], { env: profile.env, timeout: PROCESS_TIMEOUT_MS })
  const foreignCatalog = await runProcess(runtime, ["models", "opencode"], {
    env: profile.env,
    timeout: PROCESS_TIMEOUT_MS,
    expectFailure: true,
  })
  const recovery = await runProcess(runtime, ["recovery", "status", "--json"], {
    env: profile.env,
    timeout: PROCESS_TIMEOUT_MS,
  })
  requireValue(/^\d+\.\d+\.\d+(?:\r?\n)?$/u.test(version.stdout), "packaged BharatCode runtime version is invalid")
  requireValue(/bharatcode/iu.test(help.stdout), "packaged runtime does not expose BharatCode identity")
  requireValue(
    /BharatCode ships only the BharatCode provider/iu.test(foreignCatalog.stderr),
    "packaged catalog did not reject a foreign provider",
  )
  const publicHelp = `${help.stdout}\n${runHelp.stdout}`
  requireValue(
    !/\bopencode\b|--share\b|\bunshare\b|sharenext/iu.test(publicHelp),
    "ShareNext command or public runtime drift",
  )
  const recoveryStatus = JSON.parse(recovery.stdout.trim())
  requireValue(recoveryStatus?.state === "ready", "packaged BharatCode recovery state is not ready")
  return { bharatcodeOnly: true, sharenextAbsent: true }
}

async function verifyShareNetworkAbsence(netLogs) {
  const observations = await Promise.all(netLogs.map((path) => readStableFile(path, "Desktop network observation")))
  requireValue(
    observations.every(
      (bytes) =>
        !/https?:\/\/[^"\s]*(?:sharenext|\/api\/shares?(?:[/?#]|$)|bharatcode\.ai\/share)/iu.test(
          bytes.toString("utf8").replaceAll("\\/", "/"),
        ),
    ),
    "ShareNext network attempt was observed",
  )
  return true
}

async function initializeRecoveryState(installDirectory, profile) {
  const runtime = join(installDirectory, "resources", "bharatcode-opencode-cli.exe")
  requirePe(await readStableFile(runtime, "packaged candidate recovery runtime"), "packaged candidate recovery runtime")
  const initial = JSON.parse(
    (
      await runProcess(runtime, ["recovery", "status", "--json"], {
        env: profile.env,
        timeout: PROCESS_TIMEOUT_MS,
      })
    ).stdout.trim(),
  )
  if (initial?.state === "ready") return
  requireValue(
    initial?.state === "start-fresh" && initial.reason === "no-source",
    "candidate recovery state is ambiguous",
  )
  const initialized = JSON.parse(
    (
      await runProcess(runtime, ["recovery", "start-fresh", "--confirm", "--json"], {
        env: profile.env,
        timeout: PROCESS_TIMEOUT_MS,
      })
    ).stdout.trim(),
  )
  requireValue(initialized?.state === "ready", "candidate recovery initialization failed")
}

function isolatedProfile(acceptanceDirectory, environment) {
  const root = join(acceptanceDirectory, "profile")
  const roaming = join(root, "AppData", "Roaming")
  const local = join(root, "AppData", "Local")
  const temp = join(root, "Temp")
  const data = join(local, "bharatcode-beta", "Data")
  const config = join(roaming, "bharatcode-beta", "Config")
  const state = join(local, "bharatcode-beta", "State")
  const userData = join(roaming, "ai.bharatcode.desktop.beta")
  const netLogs = join(acceptanceDirectory, "network")
  const env = {
    ...safeChildEnvironment(environment),
    APPDATA: roaming,
    LOCALAPPDATA: local,
    USERPROFILE: root,
    TEMP: temp,
    TMP: temp,
    BHARATCODE_HOME: root,
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    BHARATCODE_CHANNEL: "beta",
    OPENCODE_CHANNEL: "beta",
  }
  return { root, data, config, state, userData, netLogs, env }
}

async function initializeIsolatedProfile(profile) {
  await Promise.all(
    [
      profile.root,
      profile.data,
      profile.config,
      profile.state,
      profile.userData,
      profile.netLogs,
      profile.env.TEMP,
      profile.env.XDG_DATA_HOME,
      profile.env.XDG_CONFIG_HOME,
      profile.env.XDG_CACHE_HOME,
      profile.env.XDG_STATE_HOME,
    ].map((path) => mkdir(path, { recursive: true })),
  )
}

function safeChildEnvironment(environment) {
  return Object.fromEntries(
    childEnvironmentKeys.flatMap((name) => {
      const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      const value = key ? environment[key] : undefined
      return typeof value === "string" && value ? [[name, value]] : []
    }),
  )
}

async function runProcess(executable, args, options) {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeout)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]).finally(() => clearTimeout(timeout))
  const outputBytes = stdout.byteLength + stderr.byteLength
  requireValue(outputBytes <= MAX_PROCESS_OUTPUT, "Acceptance process output exceeded its bound")
  requireValue(!timedOut, "Acceptance process timed out")
  requireValue(
    options.expectFailure ? exitCode !== 0 : exitCode === 0,
    `Acceptance process exited with code ${exitCode}`,
  )
  return {
    exitCode,
    stdout: Buffer.from(stdout).toString("utf8"),
    stderr: Buffer.from(stderr).toString("utf8"),
  }
}

async function terminateProcessTree(pid) {
  const result = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const code = await Promise.race([result.exited, delay(30_000).then(() => undefined)])
  return code === 0 || code === 128
}

async function terminateOwnedProcesses(active) {
  const results = await Promise.all([...active].map(terminateProcessTree))
  active.clear()
  return results.every(Boolean)
}

async function verifyNoOwnedProcesses(active) {
  if (!(await terminateOwnedProcesses(active))) return false
  const result = await runProcess("tasklist", ["/FI", `IMAGENAME eq ${INSTALLED_EXECUTABLE}`, "/FO", "CSV", "/NH"], {
    env: safeChildEnvironment(process.env),
    timeout: 30_000,
  })
  return !result.stdout.toLowerCase().includes(INSTALLED_EXECUTABLE)
}

async function createAcceptanceDirectory(path) {
  try {
    await mkdir(path, { recursive: false })
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("Acceptance directory is create-only and already exists")
    }
    throw error
  }
  const info = await lstat(path)
  requireValue(info.isDirectory() && !info.isSymbolicLink(), "Acceptance directory is not a local directory")
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

async function readStableFile(path, label) {
  const before = await lstat(path).catch(() => {
    throw new Error(`${label} is missing`)
  })
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, `${label} is not a regular file`)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    requireValue(sameFile(before, opened), `${label} changed before verification`)
    const bytes = await handle.readFile()
    requireValue(sameFile(opened, await handle.stat()), `${label} changed during verification`)
    return bytes
  } finally {
    await handle.close()
  }
}

async function boundedTextFiles(root, startedAt) {
  const result = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      if (!entry.isFile()) continue
      const info = await stat(path)
      if (info.size > MAX_PROCESS_OUTPUT || info.mtimeMs < startedAt - 1_000) continue
      result.push(await readFile(path, "utf8").catch(() => ""))
    }
  }
  await visit(root)
  return result
}

async function stableFiles(root) {
  const result = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      requireValue(entry.isFile(), "recovery evidence contains a non-file entry")
      result.push({ path, bytes: await readStableFile(path, "candidate recovery evidence") })
    }
  }
  await visit(root)
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

async function directoryIdentity(root) {
  const records = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      requireValue(entry.isFile(), "installed package contains a non-file entry")
      const bytes = await readStableFile(path, "installed package file")
      records.push({
        path: relative(root, path).replaceAll("\\", "/"),
        bytes: bytes.byteLength,
        sha256: digest(bytes),
      })
    }
  }
  await visit(root)
  requireValue(records.length > 0, "installed package inventory is empty")
  records.sort((left, right) => left.path.localeCompare(right.path))
  return { files: records.length, sha256: digest(Buffer.from(canonicalLeanJson(records))) }
}

function githubAuthority(env) {
  requireValue(env.GITHUB_ACTIONS === "true", "Authoritative upgrade acceptance requires GitHub Actions")
  requireValue(env.RUNNER_OS === "Windows" && env.RUNNER_ARCH === "X64", "GitHub runner must be Windows x64")
  requireValue(env.RUNNER_ENVIRONMENT === "github-hosted", "Upgrade acceptance requires a GitHub-hosted runner")
  const runId = positiveDecimal(env.GITHUB_RUN_ID, "GITHUB_RUN_ID")
  const runAttempt = positiveDecimal(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT")
  requireValue(
    safeIdentity(env.ImageOS) && safeIdentity(env.ImageVersion),
    "GitHub Windows runner image is unavailable",
  )
  return { run_id: runId, run_attempt: runAttempt, runner_image: `${env.ImageOS}-${env.ImageVersion}` }
}

function validateRemoteAsset(value, expected, url, label) {
  requireValue(value?.id === Number(expected.asset_id), `${label} ID changed`)
  requireValue(value?.name === expected.filename, `${label} filename changed`)
  requireValue(value?.size === expected.bytes, `${label} byte size changed`)
  requireValue(value?.digest === `sha256:${expected.sha256}`, `${label} digest changed`)
  requireValue(value?.url === url, `${label} repository URL changed`)
}

function validateCandidate(value) {
  requireRecord(value, ["bytes", "filename", "key", "sha256"], "candidate artifact")
  requireValue(value.key === "desktop-windows-x64", "candidate key is invalid")
  requireValue(value.filename === CANDIDATE_FILENAME, "candidate filename is invalid")
  requireValue(Number.isSafeInteger(value.bytes) && value.bytes > 0, "candidate byte size is invalid")
  requireValue(typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256), "candidate SHA-256 is invalid")
}

function requirePe(bytes, label) {
  requireValue(
    bytes.byteLength >= 4 && bytes.subarray(0, 2).toString("ascii") === "MZ" && bytes.includes(Buffer.from("PE\0\0")),
    `${label} is not a Windows PE executable`,
  )
}

function containsSecretLikeValue(value) {
  if (typeof value === "string")
    return /bearer|token|password|secret|authorization|cookie|private[_ -]?key/iu.test(value)
  if (Array.isArray(value)) return value.some(containsSecretLikeValue)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, item]) => containsSecretLikeValue(key) || containsSecretLikeValue(item))
}

function requireRecord(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  requireValue(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} keys are invalid`,
  )
}

function positiveDecimal(value, label) {
  requireValue(typeof value === "string" && /^[1-9][0-9]*$/u.test(value), `${label} is invalid`)
  requireValue(Number.isSafeInteger(Number(value)), `${label} is unsafe`)
  return value
}

function safeIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
}

function sameFile(left, right) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink"].every((key) => left[key] === right[key])
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

if (import.meta.main) {
  runLeanUpgradeAcceptance(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${result.authority}\n`),
    () => {
      process.stderr.write("Packaged upgrade acceptance failed closed\n")
      process.exitCode = 1
    },
  )
}
