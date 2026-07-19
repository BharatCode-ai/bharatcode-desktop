#!/usr/bin/env node
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Database } from "bun:sqlite"

import {
  canonicalLeanJson,
  parseCurrentBetaFixtureBytes,
  parseLeanUpgradeReceiptBytes,
} from "./lean-upgrade-receipt.mjs"
import { productNameForChannel } from "../src/main/branding.ts"

const RECEIPT_FILENAME = "upgrade-rollback-windows-x64.json"
const CANDIDATE_FILENAME = "bharatcode-desktop-next-beta-win-x64.exe"
const PACKAGED_EXECUTABLE_FILENAME = `${productNameForChannel("beta")}.exe`
const PROCESS_TIMEOUT_MS = 300_000
const STARTUP_TIMEOUT_MS = 120_000
const MAX_PROCESS_OUTPUT = 1_048_576
const ACCEPTANCE_PROJECT_ID = "proj_upgrade_acceptance"
const ACCEPTANCE_SESSION = { id: "ses_upgrade_acceptance", title: "Preserved packaged beta session" }
const ACCEPTANCE_TIME = 1_784_514_600_000
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

export async function discoverPackagedApplication(installDirectory) {
  const candidates = (await readdir(installDirectory, { withFileTypes: true })).filter(
    (entry) =>
      entry.isFile() && entry.name.toLowerCase().endsWith(".exe") && !entry.name.toLowerCase().startsWith("uninstall "),
  )
  requireValue(candidates.length === 1, "Installed package must contain exactly one root application executable")
  requireValue(candidates[0].name === PACKAGED_EXECUTABLE_FILENAME, "Installed application executable identity changed")
  const executable = join(installDirectory, candidates[0].name)
  requirePe(await readStableFile(executable, "installed BharatCode application"), "installed BharatCode application")
  return { executable }
}

export function validateOwnedProcessTree(records, expected) {
  requireValue(Array.isArray(records), "Owned process observation is invalid")
  const root = records.filter((item) => item?.process_id === expected.rootPid)
  requireValue(root.length === 1, "Owned application process is missing or ambiguous")
  requireValue(
    sameWindowsPath(root[0].executable_path, expected.executable),
    "Owned application process executable changed",
  )
  const descendants = descendantProcesses(records, expected.rootPid)
  const utility = descendants.filter(
    (item) =>
      sameWindowsPath(item.executable_path, expected.executable) &&
      /--type=utility\b/iu.test(item.command_line) &&
      /--utility-sub-type=node\.mojom\.NodeService\b/iu.test(item.command_line),
  )
  requireValue(utility.length === 1, "Owned BharatCode utility sidecar is missing or ambiguous")
  return {
    rootPid: expected.rootPid,
    utilityPid: utility[0].process_id,
    pids: [expected.rootPid, ...descendants.map((item) => item.process_id)].sort((left, right) => left - right),
  }
}

export function validateOwnedProcessesGone(pids, records) {
  requireValue(
    Array.isArray(pids) && pids.length >= 1 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
    "Owned process identity set is invalid",
  )
  requireValue(
    Array.isArray(records) && records.every((item) => !pids.includes(item?.process_id)),
    "An owned packaged process survived cleanup",
  )
  return true
}

export function parsePackagedReadinessLog(value) {
  requireValue(typeof value === "string" && value.length <= MAX_PROCESS_OUTPUT, "Packaged readiness log is invalid")
  requireValue(
    /(?:^|\r?\n)[^\r\n]*\binit step\b[^\r\n]*\bstep:\s*\{\s*phase:\s*['"]done['"]\s*\}/u.test(value),
    "Packaged application did not reach post-initialization readiness",
  )
  return true
}

export function parsePackagedReadinessDelta(previous, current) {
  requireValue(
    typeof previous === "string" && typeof current === "string" && current.startsWith(previous),
    "Packaged readiness log was replaced or truncated",
  )
  requireValue(current.length > previous.length, "Packaged readiness log did not advance")
  return parsePackagedReadinessLog(current.slice(previous.length))
}

export function selectLegacyRecoverySource(value) {
  requireRecord(value, ["sources", "state"], "candidate recovery source observation")
  requireValue(
    value.state === "choose-source" && Array.isArray(value.sources),
    "Candidate did not require source choice",
  )
  const sources = value.sources.filter(
    (source) =>
      source &&
      typeof source === "object" &&
      /^opencode-cli-[0-9a-f]{64}$/u.test(source.id) &&
      /^Existing BharatCode data · opencode-cli · [0-9a-f]{8}$/u.test(source.label) &&
      /^[0-9a-f]{64}$/u.test(source.contentFingerprint),
  )
  requireValue(
    value.sources.length === 1 && sources.length === 1,
    "Legacy OpenCode recovery source is missing or ambiguous",
  )
  return { id: sources[0].id, contentFingerprint: sources[0].contentFingerprint }
}

export function validateStateEvidence(value, expectedSession) {
  requireRecord(value, ["candidate", "recovery", "rollback", "schema", "source"], "packaged state evidence")
  requireValue(value.schema === "bharatcode-packaged-state-evidence-v1", "Packaged state evidence schema is invalid")
  requireRecord(
    value.source,
    ["config_after_sha256", "config_before_sha256", "database_after_sha256", "database_before_sha256"],
    "legacy source evidence",
  )
  requireValue(
    value.source.database_before_sha256 === value.source.database_after_sha256 &&
      value.source.config_before_sha256 === value.source.config_after_sha256,
    "Legacy source bytes changed",
  )
  requireValue(
    Object.values(value.source).every((item) => typeof item === "string" && /^[0-9a-f]{64}$/u.test(item)),
    "Legacy source digest evidence is invalid",
  )
  requireRecord(
    value.recovery,
    [
      "actions",
      "final_state",
      "journal_sha256",
      "selected_content_fingerprint",
      "selected_source_id",
      "snapshot_verified",
    ],
    "candidate recovery evidence",
  )
  requireValue(
    Array.isArray(value.recovery.actions) &&
      value.recovery.actions.length >= 1 &&
      value.recovery.actions.length <= 3 &&
      value.recovery.actions[0] === "choose-source" &&
      value.recovery.actions.every((item) => ["choose-source", "retry", "repair-marker"].includes(item)) &&
      value.recovery.final_state === "ready" &&
      /^[0-9a-f]{64}$/u.test(value.recovery.journal_sha256) &&
      value.recovery.snapshot_verified === true,
    "Candidate recovery did not complete through the eligible source",
  )
  requireValue(
    /^opencode-cli-[0-9a-f]{64}$/u.test(value.recovery.selected_source_id) &&
      /^[0-9a-f]{64}$/u.test(value.recovery.selected_content_fingerprint),
    "Candidate recovery source identity is invalid",
  )
  requireRecord(
    value.candidate,
    ["account_state", "auth_file_present", "config", "database_quick_check", "secret_like_present", "session"],
    "candidate migrated state",
  )
  requireValue(
    value.candidate.database_quick_check === "ok" &&
      sameSession(value.candidate.session, expectedSession) &&
      value.candidate.config?.snapshot === false &&
      Object.keys(value.candidate.config).length === 1 &&
      value.candidate.account_state === "signed-out" &&
      value.candidate.auth_file_present === false &&
      value.candidate.secret_like_present === false,
    "Candidate did not observe the complete safe migrated state",
  )
  requireRecord(value.rollback, ["config", "database_quick_check", "session"], "rollback state")
  requireValue(
    value.rollback.database_quick_check === "ok" &&
      sameSession(value.rollback.session, expectedSession) &&
      value.rollback.config?.snapshot === false &&
      Object.keys(value.rollback.config).length === 1,
    "Rollback could not reopen the structurally valid legacy state",
  )
  return {
    eligibleStatePreserved: true,
    migrationSourcePreserved: true,
    recoveryEvidencePreserved: true,
    rollbackStateStructurallyValid: true,
  }
}

export function validatePackagedNetLogBytes(bytes) {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength > 0, "Packaged network capture is empty")
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
  requireRecord(value, ["constants", "events"], "packaged network capture")
  requireValue(
    value.constants && typeof value.constants === "object" && !Array.isArray(value.constants),
    "Packaged network capture constants are invalid",
  )
  requireValue(Array.isArray(value.events) && value.events.length > 0, "Packaged network capture contains no events")
  requireValue(
    !/https?:\/\/(?:[^"\s]*sharenext|bharatcode\.ai\/(?:api\/)?share(?=["/?#\s]|$)|[^"\s]*\/api\/share(?=["/?#\s]|$))/iu.test(
      JSON.stringify(value),
    ),
    "ShareNext network attempt was observed",
  )
  return true
}

export function validateShareSurfaceObservation(value) {
  requireRecord(
    value,
    ["audit_requests", "schema", "session_status", "share_status", "unshare_status", "utility_process_observed"],
    "packaged share surface observation",
  )
  requireValue(
    value.schema === "bharatcode-share-surface-observation-v1" &&
      value.session_status === 200 &&
      value.share_status === 500 &&
      value.unshare_status === 500 &&
      value.audit_requests === 0 &&
      value.utility_process_observed === true,
    "Packaged ShareNext surface or local network audit did not fail closed",
  )
  return { sharenextAbsent: true, shareNetworkAttemptAbsent: true }
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
  const active = new Map()
  const audit = startLocalShareAudit()
  profile.env.BHARATCODE_SHARE_BASE_URL = audit.url
  let cleanupComplete = false
  try {
    await initializeIsolatedProfile(profile)
    const prepared = await prepareProductionInputs(input)
    await verifyPinnedInstaller(prepared.betaInstaller, input.currentBeta.assets[0])
    const betaInstalled = await runInstaller(prepared.betaInstaller, installDirectory, profile.env)
    const betaStart = await startDesktop(betaInstalled.application, installDirectory, profile, "current-beta", active)
    const seeded = await seedLegacyBetaState(profile)
    await verifyPinnedInstaller(input.candidate, prepared.candidate)
    const candidateInstalled = await runInstaller(input.candidate, installDirectory, profile.env)
    requireValue(
      candidateInstalled.executable.sha256 !== betaInstalled.executable.sha256 &&
        candidateInstalled.inventory.sha256 !== betaInstalled.inventory.sha256,
      "candidate did not replace the beta installation",
    )
    const candidateRuntime = await packagedRuntime(installDirectory)
    const recovery = await completeCandidateRecovery(candidateRuntime, profile)
    const candidateStart = await startDesktop(
      candidateInstalled.application,
      installDirectory,
      profile,
      "candidate",
      active,
    )
    const candidateState = await observeCandidateState(candidateRuntime, profile)
    const runtime = await verifyCandidateRuntime(candidateRuntime, profile)
    const share = await observeShareSurface(candidateRuntime, profile, candidateStart.processes, active, audit)
    await verifyPinnedInstaller(prepared.betaInstaller, input.currentBeta.assets[0])
    const rollbackInstalled = await runInstaller(prepared.betaInstaller, installDirectory, profile.env)
    requireValue(
      rollbackInstalled.executable.bytes === betaInstalled.executable.bytes &&
        rollbackInstalled.executable.sha256 === betaInstalled.executable.sha256 &&
        rollbackInstalled.inventory.files === betaInstalled.inventory.files &&
        rollbackInstalled.inventory.sha256 === betaInstalled.inventory.sha256,
      "rollback did not restore the exact beta installation",
    )
    const rollbackStart = await startDesktop(
      rollbackInstalled.application,
      installDirectory,
      profile,
      "rollback",
      active,
    )
    const rollbackState = await observeRollbackState(await packagedRuntime(installDirectory), profile)
    const state = validateStateEvidence(
      {
        schema: "bharatcode-packaged-state-evidence-v1",
        source: {
          database_before_sha256: seeded.databaseSha256,
          database_after_sha256: digest(await readStableFile(profile.legacyDatabase, "legacy beta database")),
          config_before_sha256: seeded.configSha256,
          config_after_sha256: digest(await readStableFile(profile.legacyConfigFile, "legacy beta config")),
        },
        recovery,
        candidate: candidateState,
        rollback: rollbackState,
      },
      ACCEPTANCE_SESSION,
    )
    const shareNetworkAttemptAbsent = await verifyShareNetworkAbsence([
      betaStart.netLog,
      candidateStart.netLog,
      rollbackStart.netLog,
    ])
    cleanupComplete = await verifyNoOwnedProcesses(active, profile.env)
    return {
      schema: "bharatcode-packaged-upgrade-observation-v1",
      candidate: prepared.candidate,
      checks: {
        current_beta_download_verified: prepared.currentBetaVerified,
        current_beta_installed_and_started: betaStart.ready,
        eligible_state_seeded: seeded.seeded,
        candidate_installed_over_beta:
          candidateInstalled.executable.sha256 !== betaInstalled.executable.sha256 &&
          candidateInstalled.inventory.sha256 !== betaInstalled.inventory.sha256,
        eligible_state_preserved: state.eligibleStatePreserved,
        candidate_started: candidateStart.ready,
        bharatcode_runtime_only: runtime.bharatcodeOnly,
        rollback_installed:
          rollbackInstalled.executable.sha256 === betaInstalled.executable.sha256 &&
          rollbackInstalled.inventory.sha256 === betaInstalled.inventory.sha256,
        rollback_state_structurally_valid: state.rollbackStateStructurallyValid,
        migration_source_preserved: state.migrationSourcePreserved,
        recovery_evidence_preserved: state.recoveryEvidencePreserved,
        sharenext_absent: share.sharenextAbsent,
        share_network_attempt_absent: share.shareNetworkAttemptAbsent && shareNetworkAttemptAbsent,
      },
      cleanup_complete: cleanupComplete,
    }
  } finally {
    const processesClean = cleanupComplete || (await terminateOwnedProcesses(active, profile.env))
    await audit.stop(true)
    if (!processesClean) {
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
  return { candidate, betaInstaller, currentBetaVerified: true }
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
  const application = await discoverPackagedApplication(installDirectory)
  const bytes = await readStableFile(application.executable, "installed BharatCode executable")
  return {
    executable: { bytes: bytes.byteLength, sha256: digest(bytes) },
    application,
    inventory: await directoryIdentity(installDirectory),
  }
}

async function startDesktop(application, installDirectory, profile, phase, active) {
  const netLog = join(profile.netLogs, `${phase}.json`)
  const logRoot = join(profile.userData, "logs")
  const checkpoints = await textFileCheckpoints(logRoot)
  const child = Bun.spawn(
    [application.executable, `--log-net-log=${netLog}`, "--net-log-capture-mode=Everything", "--disable-gpu"],
    {
      env: profile.env,
      cwd: installDirectory,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    },
  )
  active.set(child.pid, new Set([child.pid]))
  try {
    await waitForDesktopStartup(logRoot, checkpoints, child)
    const records = await observeWindowsProcesses(profile.env)
    rememberOwnedProcesses(active, child.pid, records)
    const processes = validateOwnedProcessTree(records, { rootPid: child.pid, executable: application.executable })
    processes.pids.forEach((pid) => active.get(child.pid).add(pid))
    requireValue(await terminateTrackedProcess(child.pid, active, profile.env, true), `${phase} process cleanup failed`)
    validatePackagedNetLogBytes(await readStableFile(netLog, `${phase} complete Desktop network observation`))
    return {
      ready: true,
      processes,
      netLog,
    }
  } catch (error) {
    const records = await observeWindowsProcesses(profile.env).catch(() => [])
    rememberOwnedProcesses(active, child.pid, records)
    await terminateTrackedProcess(child.pid, active, profile.env)
    throw error
  }
}

async function waitForDesktopStartup(logRoot, checkpoints, child) {
  const startedAt = Date.now()
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const exited = await Promise.race([child.exited.then((code) => ({ code })), delay(500).then(() => undefined)])
    if (exited) throw new Error(`Desktop process exited before startup completed (${exited.code})`)
    const logs = await boundedTextFiles(logRoot, startedAt, checkpoints)
    if (logs.some(hasPackagedReadiness)) return
  }
  throw new Error("Desktop startup timed out")
}

async function seedLegacyBetaState(profile) {
  const database = new Database(profile.legacyDatabase)
  try {
    requireDatabaseColumns(database, "project", ["id", "worktree", "time_created", "time_updated", "sandboxes"])
    requireDatabaseColumns(database, "session", [
      "id",
      "project_id",
      "slug",
      "directory",
      "title",
      "version",
      "time_created",
      "time_updated",
    ])
    requireDatabaseColumns(database, "account_state", ["id", "active_account_id"])
    database.transaction(() => {
      database
        .query(
          "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          ACCEPTANCE_PROJECT_ID,
          profile.projectDirectory,
          "Packaged upgrade acceptance",
          ACCEPTANCE_TIME,
          ACCEPTANCE_TIME,
          "[]",
        )
      database
        .query(
          "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          ACCEPTANCE_SESSION.id,
          ACCEPTANCE_PROJECT_ID,
          "packaged-upgrade-acceptance",
          profile.projectDirectory,
          ACCEPTANCE_SESSION.title,
          "1.0.0",
          ACCEPTANCE_TIME,
          ACCEPTANCE_TIME,
        )
      database.query("INSERT OR REPLACE INTO account_state (id, active_account_id) VALUES (1, NULL)").run()
    })()
    requireValue(database.query("PRAGMA quick_check").get()?.quick_check === "ok", "legacy beta database is corrupt")
    requireValue(
      database.query("SELECT COUNT(*) AS count FROM account").get()?.count === 0,
      "legacy beta account is not safe",
    )
    requireValue(
      sameSession(
        database.query("SELECT id, title FROM session WHERE id = ?").get(ACCEPTANCE_SESSION.id),
        ACCEPTANCE_SESSION,
      ),
      "legacy beta session was not seeded",
    )
    database.query("PRAGMA wal_checkpoint(TRUNCATE)").all()
  } finally {
    database.close()
  }
  const config = Buffer.from(canonicalLeanJson({ snapshot: false }))
  await mkdir(dirname(profile.legacyConfigFile), { recursive: true })
  await writeCreateOnly(profile.legacyConfigFile, config)
  return {
    seeded: true,
    databaseSha256: digest(await readStableFile(profile.legacyDatabase, "seeded legacy beta database")),
    configSha256: digest(await readStableFile(profile.legacyConfigFile, "seeded legacy beta config")),
  }
}

async function completeCandidateRecovery(runtime, profile) {
  const initial = await runJsonProcess(runtime, ["recovery", "status", "--json"], profile.env)
  const source = selectLegacyRecoverySource(initial)
  const actions = ["choose-source"]
  let result = await runJsonProcess(
    runtime,
    ["recovery", "choose-source", "--id", source.id, "--content-fingerprint", source.contentFingerprint, "--json"],
    profile.env,
  )
  if (result.state === "retry") {
    requireValue(
      typeof result.operationID === "string" && /^[0-9a-f-]{36}$/iu.test(result.operationID),
      "Recovery retry identity is invalid",
    )
    actions.push("retry")
    result = await runJsonProcess(
      runtime,
      ["recovery", "retry", "--operation-id", result.operationID, "--json"],
      profile.env,
    )
  }
  if (result.state === "marker-repair") {
    actions.push("repair-marker")
    result = await runJsonProcess(runtime, ["doctor", "repair", "--confirm", "--json"], profile.env)
  }
  requireValue(result.state === "ready", "Candidate recovery did not reach ready")
  const final = await runJsonProcess(runtime, ["recovery", "status", "--json"], profile.env)
  requireValue(
    final && typeof final === "object" && Object.keys(final).length === 1 && final.state === "ready",
    "Candidate recovery final status is not ready",
  )
  const evidence = await verifyRecoveryEvidence(profile, source)
  return {
    selected_source_id: source.id,
    selected_content_fingerprint: source.contentFingerprint,
    actions,
    final_state: final.state,
    journal_sha256: evidence.journalSha256,
    snapshot_verified: evidence.snapshotVerified,
  }
}

async function verifyRecoveryEvidence(profile, source) {
  const journalBytes = await readStableFile(
    join(profile.state, "lean-migration-v1.json"),
    "candidate migration journal",
  )
  const journal = JSON.parse(journalBytes.toString("utf8"))
  requireRecord(
    journal,
    [
      "artifacts",
      "contentFingerprint",
      "destinationFingerprint",
      "operationID",
      "phase",
      "snapshotDigest",
      "sourceID",
      "version",
    ],
    "candidate migration journal",
  )
  requireValue(
    journal.version === 1 &&
      journal.phase === "complete" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(journal.operationID) &&
      journal.sourceID === source.id &&
      journal.contentFingerprint === source.contentFingerprint &&
      /^[0-9a-f]{64}$/u.test(journal.snapshotDigest) &&
      journal.destinationFingerprint ===
        digest(
          Buffer.from(
            [profile.data, profile.config, profile.state, profile.candidateDatabase, profile.candidateStorage]
              .map((item) => resolve(item))
              .join("\0"),
          ),
        ) &&
      Array.isArray(journal.artifacts) &&
      journal.artifacts.length === 2 &&
      journal.artifacts[0] === `migration-snapshots/${journal.snapshotDigest}` &&
      journal.artifacts[1] === `migration-staging/${journal.operationID}`,
    "Candidate migration journal identity or chronology is invalid",
  )
  const snapshotVerified = await verifyMigrationSnapshot(
    join(profile.state, "migration-snapshots", journal.snapshotDigest),
    journal.snapshotDigest,
    source.contentFingerprint,
  )
  requireValue(snapshotVerified, "Candidate sealed migration snapshot is corrupt")
  return { journalSha256: digest(journalBytes), snapshotVerified }
}

async function verifyMigrationSnapshot(root, expectedDigest, expectedContentFingerprint) {
  const entries = await readdir(root, { withFileTypes: true })
  requireValue(
    entries.length === 2 &&
      entries.some((entry) => entry.isFile() && entry.name === "manifest.json") &&
      entries.some((entry) => entry.isDirectory() && entry.name === "records"),
    "Candidate migration snapshot layout is invalid",
  )
  const manifestBytes = await readStableFile(join(root, "manifest.json"), "candidate migration snapshot manifest")
  requireValue(digest(manifestBytes) === expectedDigest, "Candidate migration snapshot manifest digest changed")
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  requireRecord(manifest, ["contentFingerprint", "entries", "version"], "candidate migration snapshot manifest")
  requireValue(
    manifest.version === 1 &&
      manifest.contentFingerprint === expectedContentFingerprint &&
      Array.isArray(manifest.entries) &&
      manifest.entries.length > 0,
    "Candidate migration snapshot manifest identity is invalid",
  )
  const expected = []
  for (const entry of manifest.entries) {
    requireRecord(entry, ["digest", "relative", "size"], "candidate migration snapshot record")
    requireValue(
      safeRelativePath(entry.relative) &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        /^[0-9a-f]{64}$/u.test(entry.digest) &&
        !expected.includes(entry.relative),
      "Candidate migration snapshot record identity is invalid",
    )
    const bytes = await readStableFile(join(root, "records", entry.relative), "candidate migration snapshot record")
    requireValue(
      bytes.byteLength === entry.size && digest(bytes) === entry.digest,
      "Candidate migration snapshot record changed",
    )
    expected.push(entry.relative)
  }
  requireValue(
    expected.every((value, index) => index === 0 || expected[index - 1].localeCompare(value) < 0),
    "Candidate migration snapshot records are not canonically ordered",
  )
  const actual = await relativeFiles(join(root, "records"))
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

async function observeCandidateState(runtime, profile) {
  const quickCheck = await runJsonProcess(runtime, ["db", "PRAGMA quick_check", "--format", "json"], profile.env)
  const sessions = await runJsonProcess(
    runtime,
    ["db", `SELECT id, title FROM session WHERE id = '${ACCEPTANCE_SESSION.id}'`, "--format", "json"],
    profile.env,
  )
  const config = await runJsonProcess(runtime, ["--pure", "debug", "config"], profile.env, profile.projectDirectory)
  const account = await runProcess(runtime, ["auth", "status"], { env: profile.env, timeout: PROCESS_TIMEOUT_MS })
  const database = new Database(profile.candidateDatabase, { readonly: true })
  try {
    const forbidden = database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account', 'account_state', 'session_share')",
      )
      .all()
    requireValue(forbidden.length === 0, "candidate retained credential-bearing tables")
  } finally {
    database.close()
  }
  return {
    database_quick_check: exactQuickCheck(quickCheck),
    session: exactSessionRows(sessions),
    config: { snapshot: config.snapshot },
    account_state: /Signed out of BharatCode\./u.test(account.stdout) ? "signed-out" : "unknown",
    auth_file_present: await Bun.file(profile.candidateAuthFile).exists(),
    secret_like_present: await candidateSecretLikeStatePresent(profile),
  }
}

async function observeRollbackState(runtime, profile) {
  const quickCheck = await runJsonProcess(runtime, ["db", "PRAGMA quick_check", "--format", "json"], profile.env)
  const sessions = await runJsonProcess(
    runtime,
    ["db", `SELECT id, title FROM session WHERE id = '${ACCEPTANCE_SESSION.id}'`, "--format", "json"],
    profile.env,
  )
  return {
    database_quick_check: exactQuickCheck(quickCheck),
    session: exactSessionRows(sessions),
    config: {
      snapshot: JSON.parse((await readStableFile(profile.legacyConfigFile, "rollback beta config")).toString("utf8"))
        .snapshot,
    },
  }
}

async function packagedRuntime(installDirectory) {
  const runtime = join(installDirectory, "resources", "bharatcode-opencode-cli.exe")
  requirePe(await readStableFile(runtime, "packaged BharatCode runtime"), "packaged BharatCode runtime")
  return runtime
}

async function verifyCandidateRuntime(runtime, profile) {
  const version = await runProcess(runtime, ["--version"], { env: profile.env, timeout: PROCESS_TIMEOUT_MS })
  const help = await runProcess(runtime, ["--help"], { env: profile.env, timeout: PROCESS_TIMEOUT_MS })
  const foreignCatalog = await runProcess(runtime, ["models", "opencode"], {
    env: profile.env,
    timeout: PROCESS_TIMEOUT_MS,
    expectFailure: true,
  })
  requireValue(/^\d+\.\d+\.\d+(?:\r?\n)?$/u.test(version.stdout), "packaged BharatCode runtime version is invalid")
  requireValue(/bharatcode/iu.test(help.stdout), "packaged runtime does not expose BharatCode identity")
  requireValue(
    /BharatCode ships only the BharatCode provider/iu.test(foreignCatalog.stderr),
    "packaged catalog did not reject a foreign provider",
  )
  return { bharatcodeOnly: true }
}

async function verifyShareNetworkAbsence(netLogs) {
  const observations = await Promise.all(netLogs.map((path) => readStableFile(path, "Desktop network observation")))
  observations.forEach(validatePackagedNetLogBytes)
  return true
}

async function observeShareSurface(runtime, profile, desktopProcesses, active, audit) {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  const env = {
    ...profile.env,
    BHARATCODE_SERVER_USERNAME: "acceptance",
    BHARATCODE_SERVER_PASSWORD: "loopback-only",
  }
  const child = Bun.spawn([runtime, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--no-mdns"], {
    env,
    cwd: profile.projectDirectory,
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  active.set(child.pid, new Set([child.pid]))
  try {
    const headers = {
      Authorization: `Basic ${Buffer.from("acceptance:loopback-only").toString("base64")}`,
      "x-opencode-directory": profile.projectDirectory,
    }
    const sessionUrl = `http://127.0.0.1:${port}/session/${ACCEPTANCE_SESSION.id}?directory=${encodeURIComponent(profile.projectDirectory)}`
    const sessionStatus = await waitForHttpStatus(sessionUrl, headers, child)
    const shareStatus = (
      await fetch(sessionUrl.replace(/\?.*$/u, "/share"), {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
    ).status
    const unshareStatus = (
      await fetch(sessionUrl.replace(/\?.*$/u, "/share"), {
        method: "DELETE",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
    ).status
    const records = await observeWindowsProcesses(profile.env)
    rememberOwnedProcesses(active, child.pid, records)
    requireValue(
      await terminateTrackedProcess(child.pid, active, profile.env),
      "Packaged share audit server cleanup failed",
    )
    return validateShareSurfaceObservation({
      schema: "bharatcode-share-surface-observation-v1",
      session_status: sessionStatus,
      share_status: shareStatus,
      unshare_status: unshareStatus,
      audit_requests: audit.requests,
      utility_process_observed:
        Number.isSafeInteger(desktopProcesses.utilityPid) &&
        desktopProcesses.pids.includes(desktopProcesses.utilityPid),
    })
  } catch (error) {
    await terminateTrackedProcess(child.pid, active, profile.env)
    throw error
  }
}

function startLocalShareAudit() {
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1
      return new Response("blocked", { status: 503 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get requests() {
      return requests
    },
    stop: (force) => server.stop(force),
  }
}

async function waitForHttpStatus(url, headers, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const exited = await Promise.race([child.exited.then((code) => ({ code })), delay(250).then(() => undefined)])
    if (exited) throw new Error(`Packaged share audit server exited before readiness (${exited.code})`)
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    if (response?.status === 200) return response.status
  }
  throw new Error("Packaged share audit server startup timed out")
}

async function runJsonProcess(runtime, args, env, cwd) {
  const result = await runProcess(runtime, args, { env, cwd, timeout: PROCESS_TIMEOUT_MS })
  requireValue(result.stdout.length > 0, "Packaged runtime returned empty JSON")
  return JSON.parse(result.stdout.trim())
}

function exactQuickCheck(value) {
  requireValue(
    Array.isArray(value) &&
      value.length === 1 &&
      value[0] &&
      typeof value[0] === "object" &&
      Object.keys(value[0]).length === 1 &&
      value[0].quick_check === "ok",
    "Packaged database quick check failed",
  )
  return value[0].quick_check
}

function exactSessionRows(value) {
  requireValue(
    Array.isArray(value) && value.length === 1 && sameSession(value[0], ACCEPTANCE_SESSION),
    "Packaged session observation changed",
  )
  return { id: value[0].id, title: value[0].title }
}

async function candidateSecretLikeStatePresent(profile) {
  return (
    (await Bun.file(profile.candidateAuthFile).exists()) ||
    (await Bun.file(join(profile.root, ".bharatcode", "credentials.json")).exists())
  )
}

function requireDatabaseColumns(database, table, required) {
  const columns = new Set(
    database
      .query(`PRAGMA table_info(${table})`)
      .all()
      .map((item) => item.name),
  )
  requireValue(
    required.every((column) => columns.has(column)),
    `Legacy beta ${table} schema changed`,
  )
}

async function relativeFiles(root) {
  const result = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      requireValue(entry.isFile(), "Candidate migration snapshot contains a non-file entry")
      result.push(relative(root, path).replaceAll("\\", "/"))
    }
  }
  await visit(root)
  return result.sort((left, right) => left.localeCompare(right))
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/^[/\\]|^[A-Za-z]:/u.test(value) &&
    !value.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")
  )
}

function hasPackagedReadiness(value) {
  try {
    return parsePackagedReadinessLog(value)
  } catch {
    return false
  }
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
  const projectDirectory = join(acceptanceDirectory, "project")
  const legacyData = join(root, "xdg", "data", "opencode")
  const legacyConfig = join(root, "xdg", "config", "opencode")
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
  return {
    root,
    data,
    config,
    state,
    userData,
    netLogs,
    projectDirectory,
    legacyDatabase: join(legacyData, "opencode.db"),
    legacyConfigFile: join(legacyConfig, "opencode.json"),
    candidateDatabase: join(data, "bharatcode.db"),
    candidateStorage: join(data, "storage"),
    candidateAuthFile: join(data, "auth.json"),
    env,
  }
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
      profile.projectDirectory,
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

async function terminateProcessTree(pid, force) {
  const result = Bun.spawn(["taskkill", "/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const code = await Promise.race([result.exited, delay(30_000).then(() => undefined)])
  return code === 0 || code === 128
}

async function observeWindowsProcesses(env) {
  const result = await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object @{n='process_id';e={$_.ProcessId}},@{n='parent_process_id';e={$_.ParentProcessId}},@{n='executable_path';e={$_.ExecutablePath}},@{n='command_line';e={$_.CommandLine}} | ConvertTo-Json -Compress",
    ],
    { env, timeout: 30_000 },
  )
  const value = JSON.parse(result.stdout.trim())
  return (Array.isArray(value) ? value : [value]).filter(
    (item) =>
      item &&
      Number.isSafeInteger(item.process_id) &&
      Number.isSafeInteger(item.parent_process_id) &&
      typeof item.executable_path === "string" &&
      typeof item.command_line === "string",
  )
}

function rememberOwnedProcesses(active, rootPid, records) {
  if (!active.has(rootPid)) active.set(rootPid, new Set([rootPid]))
  descendantProcesses(records, rootPid).forEach((item) => active.get(rootPid).add(item.process_id))
}

async function terminateTrackedProcess(rootPid, active, env, graceful = false) {
  const pids = [...(active.get(rootPid) ?? new Set([rootPid]))]
  const requested = await terminateProcessTree(rootPid, !graceful)
  if (graceful && requested && (await waitForOwnedProcessesGone(pids, env, 15_000))) {
    active.delete(rootPid)
    return true
  }
  const terminated = graceful ? await terminateProcessTree(rootPid, true) : requested
  if (terminated && (await waitForOwnedProcessesGone(pids, env, 30_000))) {
    active.delete(rootPid)
    return true
  }
  return false
}

async function waitForOwnedProcessesGone(pids, env, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const records = await observeWindowsProcesses(env)
    try {
      validateOwnedProcessesGone(pids, records)
      return true
    } catch {
      await delay(250)
    }
  }
  return false
}

async function terminateOwnedProcesses(active, env) {
  const results = []
  for (const rootPid of [...active.keys()]) results.push(await terminateTrackedProcess(rootPid, active, env))
  return results.every(Boolean) && active.size === 0
}

async function verifyNoOwnedProcesses(active, env) {
  return terminateOwnedProcesses(active, env)
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

async function textFileCheckpoints(root) {
  const result = new Map()
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      if (!entry.isFile()) continue
      const bytes = await readStableFile(path, "packaged readiness log checkpoint")
      requireValue(bytes.byteLength <= MAX_PROCESS_OUTPUT, "Packaged readiness log checkpoint exceeded its bound")
      result.set(path, bytes.toString("utf8"))
    }
  }
  await visit(root)
  return result
}

async function boundedTextFiles(root, startedAt, checkpoints) {
  const result = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      if (!entry.isFile()) continue
      const info = await stat(path)
      if (info.size > MAX_PROCESS_OUTPUT || info.mtimeMs < startedAt - 1_000) continue
      const current = await readFile(path, "utf8")
      const previous = checkpoints.get(path) ?? ""
      requireValue(current.startsWith(previous), "Packaged readiness log was replaced or truncated")
      if (current.length > previous.length) result.push(current.slice(previous.length))
    }
  }
  await visit(root)
  return result
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

function sameWindowsPath(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase()
  )
}

function descendantProcesses(records, rootPid) {
  const result = []
  const parents = new Set([rootPid])
  while (true) {
    const next = records.filter(
      (item) =>
        Number.isSafeInteger(item?.process_id) &&
        Number.isSafeInteger(item?.parent_process_id) &&
        typeof item?.executable_path === "string" &&
        typeof item?.command_line === "string" &&
        parents.has(item.parent_process_id) &&
        item.process_id !== rootPid &&
        !result.some((known) => known.process_id === item.process_id),
    )
    if (next.length === 0) return result
    next.forEach((item) => parents.add(item.process_id))
    result.push(...next)
  }
}

function sameSession(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    value.id === expected.id &&
    value.title === expected.title
  )
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
