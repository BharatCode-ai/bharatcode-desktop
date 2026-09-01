#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
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
const MAX_CREDENTIAL_SCAN_BYTES = 67_108_864
const ACCEPTANCE_PROJECT_ID = "proj_upgrade_acceptance"
const ACCEPTANCE_SESSION = { id: "ses_upgrade_acceptance", title: "Preserved packaged beta session" }
const ACCEPTANCE_TIME = 1_784_514_600_000
const ACCEPTANCE_ACCOUNT_ID = "acc_upgrade_acceptance"
const ACCEPTANCE_ACCESS_SENTINEL = "bharatcode-cp3-inert-access-sentinel"
const ACCEPTANCE_REFRESH_SENTINEL = "bharatcode-cp3-inert-refresh-sentinel"
const ACCEPTANCE_CREDENTIAL_SENTINELS = [ACCEPTANCE_ACCESS_SENTINEL, ACCEPTANCE_REFRESH_SENTINEL]
const ACCEPTANCE_SHARE_TOKEN = "bharatcode-cp3-inert-share-audit-token"
const ACCEPTANCE_FIREWALL_RULE = "BharatCode CP3 packaged share public-network block"
const ACCEPTANCE_EGRESS_PATH = "/bharatcode-firewall-control"
const CURRENT_BETA_MIGRATIONS = [
  "20260127222353_familiar_lady_ursula",
  "20260211171708_add_project_commands",
  "20260213144116_wakeful_the_professor",
  "20260225215848_workspace",
  "20260227213759_add_session_workspace_id",
  "20260228203230_blue_harpoon",
  "20260303231226_add_workspace_fields",
  "20260309230000_move_org_to_state",
  "20260312043431_session_message_cursor",
  "20260323234822_events",
  "20260410174513_workspace-name",
  "20260413175956_chief_energizer",
  "20260423070820_add_icon_url_override",
  "20260427172553_slow_nightmare",
  "20260428004200_add_session_path",
  "20260501142318_next_venus",
  "20260504145000_add_sync_owner",
  "20260507164347_add_workspace_time",
  "20260510033149_session_usage",
  "20260511000411_data_migration_state",
  "20260630000000_add_goal_mode",
]
const ACCEPTANCE_FIREWALL_REMOTE_RANGES = [
  "0.0.0.0-126.255.255.255",
  "128.0.0.0-255.255.255.255",
  "::",
  "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
]
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
  "current_beta_installed",
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
  const rootSwitches = parseWindowsChromiumSwitches(root[0].command_line)
  validateAddressSpaceSwitches(rootSwitches, expected.addressSpaceOverrideArguments ?? [], "root")
  const descendants = descendantProcesses(records, expected.rootPid)
  const descendantObservations = descendants.map((item) => ({
    ...item,
    switches: parseWindowsChromiumSwitches(item.command_line),
  }))
  const utility = descendantObservations.filter(
    (item) =>
      sameWindowsPath(item.executable_path, expected.executable) &&
      hasSingleEffectiveSwitch(item.switches, "type", "utility") &&
      hasSingleEffectiveSwitch(item.switches, "utility-sub-type", "node.mojom.NodeService"),
  )
  requireValue(utility.length === 1, "Owned BharatCode utility sidecar is missing or ambiguous")
  const networkService = descendantObservations.filter(
    (item) =>
      sameWindowsPath(item.executable_path, expected.executable) &&
      hasSingleEffectiveSwitch(item.switches, "type", "utility") &&
      hasSingleEffectiveSwitch(item.switches, "utility-sub-type", "network.mojom.NetworkService"),
  )
  if (expected.requireNetworkService) {
    requireValue(networkService.length === 1, "Owned Chromium NetworkService is missing or ambiguous")
    validateCandidateNetworkSwitches(rootSwitches, expected.addressSpaceOverrideArguments ?? [], "root")
    validateCandidateNetworkSwitches(
      networkService[0].switches,
      expected.addressSpaceOverrideArguments ?? [],
      "NetworkService",
    )
  } else {
    requireValue(networkService.length <= 1, "Owned Chromium NetworkService is ambiguous")
  }
  return {
    rootPid: expected.rootPid,
    utilityPid: utility[0].process_id,
    ...(expected.requireNetworkService ? { networkServicePid: networkService[0].process_id } : {}),
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
    !/(?:sidecar health check failed|sidecar exited|utility process (?:error|gone)|child process gone|render process gone)/iu.test(
      value,
    ),
    "Packaged application reported a sidecar or process startup failure",
  )
  requireValue(
    /(?:^|\r?\n)[^\r\n]*\binit step\b[^\r\n]*\bstep:\s*\{\s*phase:\s*['"]done['"]\s*\}/u.test(value),
    "Packaged application did not reach post-initialization readiness",
  )
  return true
}

export function validatePackagedReadinessObservation(value, expected) {
  requireRecord(value, ["log_delta", "processes"], "packaged readiness observation")
  parsePackagedReadinessLog(value.log_delta)
  const origins = [
    ...value.log_delta.matchAll(
      /(?:^|\r?\n)[^\r\n]*\bsidecar connection started\b[^\r\n]*\burl:\s*['"](http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})['"]/gu,
    ),
  ].map((match) => match[1])
  requireValue(origins.length === 1, "Packaged sidecar origin is missing or ambiguous")
  requireLoopbackOrigin(origins[0], "Packaged sidecar origin")
  return { ...validateOwnedProcessTree(value.processes, expected), sidecarOrigin: origins[0] }
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
      "sentinels_absent",
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
      value.recovery.sentinels_absent === true &&
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
    ["account_state", "config", "credential_store_usable", "database_quick_check", "sentinel_present", "session"],
    "candidate migrated state",
  )
  requireValue(
    value.candidate.database_quick_check === "ok" &&
      sameSession(value.candidate.session, expectedSession) &&
      value.candidate.config?.snapshot === false &&
      Object.keys(value.candidate.config).length === 1 &&
      value.candidate.account_state === "signed-out" &&
      value.candidate.credential_store_usable === false &&
      value.candidate.sentinel_present === false,
    "Candidate did not observe the complete safe migrated state",
  )
  requireRecord(
    value.rollback,
    ["config", "database_quick_check", "legacy_account_intact", "session"],
    "rollback state",
  )
  requireValue(
    value.rollback.database_quick_check === "ok" &&
      sameSession(value.rollback.session, expectedSession) &&
      value.rollback.config?.snapshot === false &&
      Object.keys(value.rollback.config).length === 1 &&
      value.rollback.legacy_account_intact === true,
    "Rollback could not reopen the structurally valid legacy state",
  )
  return {
    eligibleStatePreserved: true,
    migrationSourcePreserved: true,
    recoveryEvidencePreserved: true,
    rollbackStateStructurallyValid: true,
  }
}

export function observeCredentialStoreUsability(values, sentinels = ACCEPTANCE_CREDENTIAL_SENTINELS) {
  requireValue(Array.isArray(values) && values.length <= 16, "Candidate credential store inventory is invalid")
  if (observeCredentialSentinelPresence(values, sentinels)) return true
  return values.some((bytes) => {
    requireValue(
      bytes instanceof Uint8Array && bytes.byteLength <= MAX_PROCESS_OUTPUT,
      "Candidate credential store is invalid",
    )
    const text = Buffer.from(bytes).toString("utf8").trim()
    if (!text) return false
    const value = JSON.parse(text)
    requireValue(
      Array.isArray(value) || (value && typeof value === "object"),
      "Candidate credential store JSON is invalid",
    )
    return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
  })
}

export function observeCredentialSentinelPresence(values, sentinels = ACCEPTANCE_CREDENTIAL_SENTINELS) {
  requireValue(
    Array.isArray(values) &&
      values.length <= 4096 &&
      values.every((bytes) => bytes instanceof Uint8Array) &&
      values.reduce((total, bytes) => total + bytes.byteLength, 0) <= MAX_CREDENTIAL_SCAN_BYTES,
    "Credential sentinel scan is invalid or exceeds its bound",
  )
  requireValue(
    Array.isArray(sentinels) &&
      sentinels.length === 2 &&
      sentinels.every((value) => typeof value === "string" && value.length >= 16),
    "Credential sentinel identity is invalid",
  )
  const needles = sentinels.map((value) => Buffer.from(value))
  return values.some((bytes) => needles.some((needle) => Buffer.from(bytes).includes(needle)))
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

export function createEgressControlUrls(origin, nonces = Array.from({ length: 4 }, () => randomUUID())) {
  let base
  try {
    base = new URL(origin)
  } catch {
    throw new Error("Firewall egress control origin is invalid")
  }
  requireValue(
    base.protocol === "http:" &&
      isPrivateIpv4(base.hostname) &&
      Number(base.port) >= 1 &&
      Number(base.port) <= 65535 &&
      base.username === "" &&
      base.password === "" &&
      base.pathname === "/" &&
      base.search === "" &&
      base.hash === "" &&
      base.origin === origin,
    "Firewall egress control origin is invalid",
  )
  requireValue(
    Array.isArray(nonces) &&
      nonces.length === 4 &&
      new Set(nonces).size === 4 &&
      nonces.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)),
    "Firewall egress control nonces are invalid or reused",
  )
  const url = (nonce) => `${origin}${ACCEPTANCE_EGRESS_PATH}/${nonce}`
  return {
    harnessBefore: url(nonces[0]),
    rendererBefore: url(nonces[1]),
    rendererBlocked: url(nonces[2]),
    harnessAfter: url(nonces[3]),
  }
}

export function validateCandidateEgressNetLogBytes(bytes, controls) {
  validatePackagedNetLogBytes(bytes)
  requireRecord(
    controls,
    ["harnessAfter", "harnessBefore", "rendererBefore", "rendererBlocked"],
    "candidate egress netlog controls",
  )
  const values = Object.values(controls)
  requireValue(new Set(values).size === 4, "candidate egress netlog controls are reused")
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"))
  const eventTypes = parsed.constants.logEventTypes
  requireValue(
    eventTypes && typeof eventTypes === "object" && !Array.isArray(eventTypes),
    "candidate egress netlog event types are invalid",
  )
  const names = new Map(Object.entries(eventTypes).map(([name, type]) => [type, name]))
  const starts = (url) =>
    parsed.events.filter((event) => names.get(event?.type) === "URL_REQUEST_START_JOB" && event?.params?.url === url)
  const before = starts(controls.rendererBefore)
  const blocked = starts(controls.rendererBlocked)
  requireValue(
    before.length === 1 &&
      before[0]?.params?.method === "GET" &&
      blocked.length === 1 &&
      blocked[0]?.params?.method === "GET",
    "candidate egress netlog request identity is incomplete or contains a preflight",
  )
  requireValue(
    parsed.events.indexOf(before[0]) < parsed.events.indexOf(blocked[0]),
    "candidate egress netlog request chronology changed",
  )
  requireValue(
    starts(controls.harnessBefore).length === 0 && starts(controls.harnessAfter).length === 0,
    "harness egress control leaked into the candidate netlog",
  )
  const connected = (root) => {
    const ids = new Set([root.source.id])
    let changed = true
    while (changed) {
      changed = false
      for (const event of parsed.events) {
        const dependencies = networkSourceDependencies(event.params)
        if (!ids.has(event?.source?.id) && !dependencies.some((id) => ids.has(id))) continue
        for (const id of [event?.source?.id, ...dependencies]) {
          if (!Number.isSafeInteger(id) || ids.has(id)) continue
          ids.add(id)
          changed = true
        }
      }
    }
    return parsed.events.filter((event) => ids.has(event?.source?.id))
  }
  const beforeEvents = connected(before[0])
  const blockedEvents = connected(blocked[0])
  requireValue(
    beforeEvents.some(
      (event) =>
        /READ_RESPONSE_HEADERS/u.test(names.get(event.type) ?? "") &&
        networkStringValues(event.params).some((value) => /^HTTP\/1\.[01] 204(?:\s|$)/u.test(value)),
    ),
    "candidate pre-boundary netlog has no exact 204 response",
  )
  requireValue(
    !blockedEvents.some((event) => /READ_RESPONSE_HEADERS/u.test(names.get(event.type) ?? "")) &&
      blockedEvents.some((event) => Number.isInteger(event?.params?.net_error) && event.params.net_error < 0),
    "candidate blocked netlog has a response or no network failure",
  )
  return true
}

function validateEgressControlUrls(controls, expectedAddress) {
  requireRecord(
    controls,
    ["harnessAfter", "harnessBefore", "rendererBefore", "rendererBlocked"],
    "firewall egress control URLs",
  )
  const urls = Object.values(controls).map((value) => {
    requireValue(typeof value === "string", "Firewall egress control URL is invalid")
    try {
      return new URL(value)
    } catch {
      throw new Error("Firewall egress control URL is invalid")
    }
  })
  requireValue(
    urls.every((url) => url.origin === urls[0].origin && url.hostname === expectedAddress),
    "Firewall egress control endpoint changed",
  )
  const nonces = urls.map((url) => url.pathname.slice(`${ACCEPTANCE_EGRESS_PATH}/`.length))
  const expected = createEgressControlUrls(urls[0].origin, nonces)
  requireValue(
    Object.keys(expected).every((key) => expected[key] === controls[key]),
    "Firewall egress control URL roles changed",
  )
  return structuredClone(controls)
}

export function validateShareSurfaceObservation(value) {
  requireRecord(
    value,
    [
      "after_pids",
      "audit_requests",
      "before_pids",
      "delete",
      "post",
      "renderer_origin",
      "root_pid",
      "schema",
      "sidecar_origin",
      "target_id",
      "unauthenticated_control",
      "utility_pid",
    ],
    "packaged share surface observation",
  )
  requireLoopbackOrigin(value.sidecar_origin, "Packaged share sidecar origin")
  requireValue(
    value.schema === "bharatcode-live-electron-share-observation-v1" &&
      value.renderer_origin === "oc://renderer" &&
      typeof value.target_id === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/u.test(value.target_id) &&
      Number.isSafeInteger(value.root_pid) &&
      Number.isSafeInteger(value.utility_pid) &&
      value.root_pid > 0 &&
      value.utility_pid > 0 &&
      value.root_pid !== value.utility_pid &&
      samePidSet(value.before_pids, value.after_pids) &&
      value.before_pids.includes(value.root_pid) &&
      value.before_pids.includes(value.utility_pid),
    "Live Electron or utility sidecar identity changed during ShareNext observation",
  )
  validateUnauthenticatedSidecarResponse(value.unauthenticated_control, value.sidecar_origin)
  validateDisabledShareResponse(value.post, value.sidecar_origin)
  validateDisabledShareResponse(value.delete, value.sidecar_origin)
  requireValue(value.audit_requests === 0, "Packaged ShareNext surface or local network audit did not fail closed")
  return { sharenextAbsent: true, shareNetworkAttemptAbsent: true }
}

export function validateUnauthenticatedSidecarResponse(value, sidecarOrigin) {
  requireLoopbackOrigin(sidecarOrigin, "Packaged share sidecar origin")
  requireRecord(
    value,
    ["body", "content_type", "redirected", "status", "url", "www_authenticate"],
    "unauthenticated sidecar control response",
  )
  requireValue(
    value.status === 401 &&
      value.content_type === null &&
      value.body === "" &&
      value.url === `${sidecarOrigin}/session/${ACCEPTANCE_SESSION.id}/share` &&
      value.redirected === false &&
      value.www_authenticate === 'Basic realm="Secure Area"',
    "Packaged sidecar did not enforce the exact Basic-auth boundary",
  )
  return true
}

export function validateFirewallProfileObservation(value) {
  requireRecord(value, ["active_profiles", "control_address", "profiles", "schema"], "firewall observation")
  requireValue(value.schema === "bharatcode-windows-firewall-observation-v1", "Firewall schema is invalid")
  requireValue(
    typeof value.control_address === "string" && isPrivateIpv4(value.control_address),
    "Firewall control address is not a closed non-loopback host address",
  )
  requireValue(
    Array.isArray(value.active_profiles) &&
      value.active_profiles.length >= 1 &&
      value.active_profiles.length <= 3 &&
      value.active_profiles.every((profile) => ["Domain", "Private", "Public"].includes(profile)) &&
      new Set(value.active_profiles).size === value.active_profiles.length &&
      value.active_profiles.every((profile, index) => index === 0 || value.active_profiles[index - 1] < profile),
    "Active firewall profile identity is invalid or ambiguous",
  )
  requireValue(Array.isArray(value.profiles) && value.profiles.length === 3, "Firewall profile inventory is invalid")
  for (const [index, name] of ["Domain", "Private", "Public"].entries()) {
    requireRecord(value.profiles[index], ["enabled", "name"], "firewall profile")
    requireValue(value.profiles[index].name === name, "Firewall profile inventory is not exact and ordered")
    requireValue(typeof value.profiles[index].enabled === "boolean", "Firewall profile state is invalid")
  }
  requireValue(
    value.active_profiles.every((name) => value.profiles.find((profile) => profile.name === name)?.enabled === true),
    "An active Windows Firewall profile is disabled",
  )
  return structuredClone(value)
}

export function validateBlockedEgressObservation(value, firewall) {
  const profile = validateFirewallProfileObservation(firewall)
  requireRecord(
    value,
    [
      "control_urls",
      "post_boundary_control",
      "preflight_observed",
      "reachable_control",
      "renderer_origin",
      "request_failed",
      "request_sequence_after",
      "request_sequence_before",
      "request_sequence_blocked",
      "requests_after",
      "requests_before",
      "requests_blocked",
      "schema",
    ],
    "candidate egress control observation",
  )
  const controls = validateEgressControlUrls(value.control_urls, profile.control_address)
  validateReachableEgressControl(value.reachable_control, controls.rendererBefore)
  validateHarnessEgressControl(value.post_boundary_control, controls.harnessAfter)
  const expectedSequence = ["harness-before", "renderer-before"]
  const expectedFinalSequence = [...expectedSequence, "harness-after"]
  requireValue(
    value.schema === "bharatcode-candidate-egress-control-v1" &&
      value.renderer_origin === "oc://renderer" &&
      value.preflight_observed === false &&
      sameStringSequence(value.request_sequence_before, expectedSequence) &&
      sameStringSequence(value.request_sequence_blocked, expectedSequence) &&
      sameStringSequence(value.request_sequence_after, expectedFinalSequence) &&
      value.request_failed === true &&
      value.requests_before === expectedSequence.length &&
      value.requests_blocked === expectedSequence.length &&
      value.requests_after === expectedFinalSequence.length,
    "Candidate process did not prove enforced non-loopback egress blocking",
  )
  return true
}

export function routeEgressControlRequest(request, controlUrl) {
  requireValue(request instanceof Request, "Firewall egress control request is invalid")
  requireValue(typeof controlUrl === "string" && request.url === controlUrl, "Firewall egress control URL changed")
  const origin = request.headers.get("origin")
  const requestedMethod = request.headers.get("access-control-request-method")
  const requestedPrivateNetwork = request.headers.get("access-control-request-private-network")
  const requestedHeaders = request.headers.get("access-control-request-headers")
  if (request.method === "OPTIONS") {
    requireValue(
      origin === "oc://renderer" &&
        requestedMethod === "GET" &&
        requestedPrivateNetwork === "true" &&
        requestedHeaders === null,
      "Firewall egress control preflight identity is invalid",
    )
    return {
      kind: "renderer-preflight",
      response: new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET",
          "access-control-allow-origin": "oc://renderer",
          "access-control-allow-private-network": "true",
          "access-control-max-age": "0",
          "cache-control": "no-store",
          connection: "close",
        },
      }),
    }
  }
  requireValue(
    request.method === "GET" &&
      requestedMethod === null &&
      requestedPrivateNetwork === null &&
      requestedHeaders === null &&
      (origin === null || origin === "oc://renderer"),
    "Firewall egress control request identity is invalid",
  )
  return {
    kind: origin === null ? "harness-get" : "renderer-get",
    response: new Response(null, {
      status: 204,
      headers: {
        ...(origin === "oc://renderer"
          ? {
              "access-control-allow-origin": "oc://renderer",
              "access-control-expose-headers": "Cache-Control, Connection, X-BharatCode-Egress-Control",
            }
          : {}),
        "cache-control": "no-store",
        connection: "close",
        "x-bharatcode-egress-control": "active",
      },
    }),
  }
}

export function candidateAddressSpaceOverrideArguments(phase, controlUrl) {
  requireValue(["current-beta", "candidate", "rollback"].includes(phase), "Packaged Desktop launch phase is invalid")
  if (phase !== "candidate") {
    requireValue(controlUrl === undefined, "Chromium address-space override is candidate-only")
    return []
  }
  requireValue(typeof controlUrl === "string", "Candidate Chromium address-space control is missing")
  let control
  try {
    control = new URL(controlUrl)
  } catch {
    throw new Error("Candidate Chromium address-space control is invalid")
  }
  const port = Number(control.port)
  requireValue(
    control.protocol === "http:" &&
      isPrivateIpv4(control.hostname) &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      control.username === "" &&
      control.password === "" &&
      new RegExp(
        `^${ACCEPTANCE_EGRESS_PATH}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
        "u",
      ).test(control.pathname) &&
      control.search === "" &&
      control.hash === "" &&
      control.href === controlUrl,
    "Candidate Chromium address-space control is invalid",
  )
  return [`--ip-address-space-overrides=${control.hostname}:${port}=public`]
}

function validateReachableEgressControl(value, controlUrl) {
  requireRecord(
    value,
    ["body", "cache_control", "connection", "control_header", "redirected", "status", "url"],
    "reachable candidate egress control",
  )
  requireValue(
    value.status === 204 &&
      value.body === "" &&
      value.url === controlUrl &&
      value.redirected === false &&
      value.cache_control === "no-store" &&
      value.connection === "close" &&
      value.control_header === "active",
    "Candidate renderer did not reach the exact pre-boundary egress control",
  )
  return true
}

function validateHarnessEgressControl(value, controlUrl) {
  requireRecord(
    value,
    ["body", "cache_control", "connection", "control_header", "redirected", "status", "url"],
    "harness egress control observation",
  )
  requireValue(
    value.status === 204 &&
      value.body === "" &&
      value.url === controlUrl &&
      value.redirected === false &&
      value.cache_control === "no-store" &&
      value.connection === "close" &&
      value.control_header === "active",
    "Harness could not prove the exact firewall control remained reachable",
  )
  return true
}

export async function runAcceptanceWithCleanup(operation, cleanup) {
  requireValue(typeof operation === "function", "Packaged upgrade acceptance operation is invalid")
  requireRecord(cleanup, ["audit", "boundary", "egress", "processes"], "packaged acceptance cleanup")
  const invalidCleanup = Object.values(cleanup).some((item) => typeof item !== "function")
  requireValue(!invalidCleanup, "Packaged acceptance cleanup operation is invalid")
  let result
  let original
  try {
    result = await operation()
  } catch (error) {
    original = error
  }
  const failures = []
  for (const label of ["processes", "boundary", "audit", "egress"]) {
    try {
      if ((await cleanup[label]()) !== true) failures.push(label)
    } catch {
      failures.push(label)
    }
  }
  if (original && failures.length > 0) {
    throw new AggregateError(
      [original, ...failures.map((label) => new Error(`cleanup:${label}`))],
      `Packaged upgrade acceptance failed; cleanup failed: ${failures.join(",")}`,
    )
  }
  if (original) throw original
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((label) => new Error(`cleanup:${label}`)),
      `Packaged upgrade acceptance cleanup failed: ${failures.join(",")}`,
    )
  }
  return result
}

export function selectRendererCdpTarget(value, port) {
  requireValue(Number.isSafeInteger(port) && port >= 1 && port <= 65535, "CDP port is invalid")
  requireValue(Array.isArray(value), "CDP target inventory is invalid")
  const targets = value.filter(
    (item) =>
      item?.type === "page" &&
      typeof item.id === "string" &&
      /^oc:\/\/renderer(?:\/|$)/u.test(item.url) &&
      item.webSocketDebuggerUrl === `ws://127.0.0.1:${port}/devtools/page/${item.id}`,
  )
  requireValue(
    value.length === 1 && targets.length === 1,
    "Exact renderer CDP target is missing, foreign, or ambiguous",
  )
  return structuredClone(targets[0])
}

export function parseRendererShareEvaluation(value, id) {
  requireValue(
    Number.isSafeInteger(id) &&
      value?.id === id &&
      !Object.hasOwn(value, "error") &&
      value.result &&
      !Object.hasOwn(value.result, "exceptionDetails") &&
      value.result.result?.type === "object" &&
      value.result.result.value &&
      typeof value.result.result.value === "object",
    "Renderer CDP ShareNext evaluation failed or was substituted",
  )
  return structuredClone(value.result.result.value)
}

export function validateLoopbackListenerOwner(value, expected) {
  requireValue(
    Array.isArray(value) &&
      Number.isSafeInteger(expected?.port) &&
      expected.port >= 1 &&
      expected.port <= 65535 &&
      Number.isSafeInteger(expected?.pid) &&
      expected.pid > 0,
    "Loopback listener observation is invalid",
  )
  const listeners = value.filter(
    (item) => item?.local_address === "127.0.0.1" && item.local_port === expected.port && item.state === "Listen",
  )
  requireValue(
    listeners.length === 1 && listeners[0].owning_process === expected.pid,
    "Loopback listener is missing, ambiguous, or owned by a stale process",
  )
  return true
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
  const githubToken = consumeGithubActionsToken(input.environment)
  const installDirectory = join(input.acceptanceDirectory, "installed")
  const profile = isolatedProfile(input.acceptanceDirectory, input.environment)
  const active = new Map()
  const audit = startLocalShareAudit()
  let egress
  let candidateExecutable = join(installDirectory, PACKAGED_EXECUTABLE_FILENAME)
  const observation = await runAcceptanceWithCleanup(
    async () => {
      await initializeIsolatedProfile(profile)
      const prepared = await prepareProductionInputs(input, githubToken)
      await verifyPinnedInstaller(prepared.betaInstaller, input.currentBeta.assets[0])
      const betaInstalled = await runInstaller(prepared.betaInstaller, installDirectory, profile.env)
      await initializePinnedBetaDatabase(profile.legacyDatabase)
      const seeded = await seedLegacyBetaState(profile)
      await verifyPinnedInstaller(input.candidate, prepared.candidate)
      const candidateInstalled = await runInstaller(input.candidate, installDirectory, profile.env)
      candidateExecutable = candidateInstalled.application.executable
      requireValue(
        candidateInstalled.executable.sha256 !== betaInstalled.executable.sha256 &&
          candidateInstalled.inventory.sha256 !== betaInstalled.inventory.sha256,
        "candidate did not replace the beta installation",
      )
      const candidateRuntime = await packagedRuntime(installDirectory)
      const recovery = await completeCandidateRecovery(candidateRuntime, profile)
      const runtime = await verifyCandidateRuntime(candidateRuntime, profile)
      const remoteDebuggingPort = await reserveLoopbackPort()
      const firewall = await observeFirewallProfiles(profile.env)
      egress = startLocalEgressControl(firewall.control_address)
      await proveEgressControlReachability(egress)
      profile.env.BHARATCODE_SHARE_BASE_URL = audit.url
      profile.env.BHARATCODE_SHARE_ACCESS_TOKEN = ACCEPTANCE_SHARE_TOKEN
      const candidateStart = await startDesktop(
        candidateInstalled.application,
        installDirectory,
        profile,
        "candidate",
        active,
        { keepAlive: true, remoteDebuggingPort, localNetworkControlUrl: egress.urls.rendererBefore },
      )
      const share = await observeShareSurface(profile, candidateStart, remoteDebuggingPort, audit, firewall, egress)
      await finishDesktop(candidateStart, active, profile, "candidate", share.controls)
      requireValue(audit.requests === 0, "ShareNext network audit changed before candidate cleanup completed")
      requireValue(
        await removeCandidateNetworkBoundary(candidateInstalled.application.executable, profile.env),
        "Candidate public-network boundary cleanup failed",
      )
      delete profile.env.BHARATCODE_SHARE_BASE_URL
      delete profile.env.BHARATCODE_SHARE_ACCESS_TOKEN
      const candidateState = await observeCandidateState(candidateRuntime, profile)
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
      const shareNetworkAttemptAbsent = await verifyShareNetworkAbsence([candidateStart.netLog, rollbackStart.netLog])
      requireValue(await verifyNoOwnedProcesses(active, profile.env), "Packaged upgrade process cleanup is incomplete")
      return {
        schema: "bharatcode-packaged-upgrade-observation-v1",
        candidate: prepared.candidate,
        checks: {
          current_beta_download_verified: prepared.currentBetaVerified,
          current_beta_installed: true,
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
      }
    },
    {
      processes: () => terminateOwnedProcesses(active, profile.env),
      boundary: () => removeCandidateNetworkBoundary(candidateExecutable, profile.env),
      audit: async () => {
        delete profile.env.BHARATCODE_SHARE_BASE_URL
        delete profile.env.BHARATCODE_SHARE_ACCESS_TOKEN
        await audit.stop(true)
        return true
      },
      egress: () => (egress ? egress.stop(true) : true),
    },
  )
  return { ...observation, cleanup_complete: true }
}

async function prepareProductionInputs(input, githubToken) {
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
  await downloadCurrentBeta(input.currentBeta, betaInstaller, githubToken)
  return { candidate, betaInstaller, currentBetaVerified: true }
}

async function downloadCurrentBeta(fixture, destination, token) {
  const releaseUrl = `https://api.github.com/repos/${fixture.repository}/releases/${fixture.release_id}`
  const assetUrl = `https://api.github.com/repos/${fixture.repository}/releases/assets/${fixture.assets[0].asset_id}`
  const release = await fetchJson(releaseUrl, token)
  const asset = await fetchJson(assetUrl, token)
  const tagCommitSha = await resolveTagCommit(fixture, token)
  validateCurrentBetaApiObservation({ release, tag_commit_sha: tagCommitSha, asset }, fixture)
  const response = await fetch(assetUrl, {
    headers: githubApiHeaders("application/octet-stream", token),
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`Current-beta asset download failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const expected = fixture.assets[0]
  requireValue(bytes.byteLength === expected.bytes, "current-beta downloaded byte size changed")
  requireValue(digest(bytes) === expected.sha256, "current-beta downloaded SHA-256 changed")
  requirePe(bytes, "current-beta installer")
  await writeCreateOnly(destination, bytes)
}

async function resolveTagCommit(fixture, token) {
  const ref = await fetchJson(
    `https://api.github.com/repos/${fixture.repository}/git/ref/tags/${encodeURIComponent(fixture.tag)}`,
    token,
  )
  requireValue(ref?.ref === `refs/tags/${fixture.tag}`, "current-beta tag reference changed")
  if (ref.object?.type === "commit") return ref.object.sha
  requireValue(
    ref.object?.type === "tag" && /^[0-9a-f]{40}$/u.test(ref.object.sha),
    "current-beta tag object is invalid",
  )
  const tag = await fetchJson(`https://api.github.com/repos/${fixture.repository}/git/tags/${ref.object.sha}`, token)
  requireValue(tag?.object?.type === "commit", "current-beta annotated tag does not resolve to a commit")
  return tag.object.sha
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: githubApiHeaders("application/vnd.github+json", token),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`GitHub identity request failed with HTTP ${response.status}`)
  return response.json()
}

export function githubApiHeaders(accept, token) {
  requireValue(
    typeof token === "string" && token.length >= 20 && token.length <= 512 && !/[\0-\x20\x7f]/u.test(token),
    "GitHub Actions token is unavailable",
  )
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "bharatcode-packaged-upgrade-acceptance",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

export function consumeGithubActionsToken(environment) {
  const token = environment?.GITHUB_TOKEN
  try {
    githubApiHeaders("application/vnd.github+json", token)
    return token
  } finally {
    if (environment && typeof environment === "object") delete environment.GITHUB_TOKEN
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

async function startDesktop(application, installDirectory, profile, phase, active, options = {}) {
  const netLog = join(profile.netLogs, `${phase}.json`)
  const logRoot = join(profile.userData, "logs")
  const checkpoints = await textFileCheckpoints(logRoot)
  const addressSpaceOverrideArguments = candidateAddressSpaceOverrideArguments(phase, options.localNetworkControlUrl)
  const child = Bun.spawn(
    [
      application.executable,
      `--log-net-log=${netLog}`,
      "--net-log-capture-mode=Everything",
      "--disable-gpu",
      ...(options.remoteDebuggingPort
        ? ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${options.remoteDebuggingPort}`]
        : []),
      ...addressSpaceOverrideArguments,
      ...(phase === "candidate" ? ["--no-proxy-server"] : []),
    ],
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
    const logDelta = await waitForDesktopStartup(logRoot, checkpoints, child)
    const records = await observeWindowsProcesses(profile.env)
    rememberOwnedProcesses(active, child.pid, records)
    const processes = validatePackagedReadinessObservation(
      { log_delta: logDelta, processes: records },
      {
        rootPid: child.pid,
        executable: application.executable,
        addressSpaceOverrideArguments,
        requireNetworkService: phase === "candidate",
      },
    )
    processes.pids.forEach((pid) => active.get(child.pid).add(pid))
    if (options.keepAlive) {
      return {
        ready: true,
        executable: application.executable,
        processes,
        addressSpaceOverrideArguments,
        sidecarOrigin: processes.sidecarOrigin,
        netLog,
      }
    }
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

async function finishDesktop(start, active, profile, phase, egressControls) {
  requireValue(
    await terminateTrackedProcess(start.processes.rootPid, active, profile.env, true),
    `${phase} process cleanup failed`,
  )
  const bytes = await readStableFile(start.netLog, `${phase} complete Desktop network observation`)
  validatePackagedNetLogBytes(bytes)
  if (egressControls) validateCandidateEgressNetLogBytes(bytes, egressControls)
  return true
}

async function waitForDesktopStartup(logRoot, checkpoints, child) {
  const startedAt = Date.now()
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const exited = await Promise.race([child.exited.then((code) => ({ code })), delay(500).then(() => undefined)])
    if (exited) throw new Error(`Desktop process exited before startup completed (${exited.code})`)
    const logs = await boundedTextFiles(logRoot, startedAt, checkpoints)
    requireValue(
      !logs.some((value) =>
        /(?:sidecar health check failed|sidecar exited|utility process (?:error|gone)|child process gone|render process gone)/iu.test(
          value,
        ),
      ),
      "Desktop reported a sidecar or process startup failure",
    )
    const ready = logs.filter(hasPackagedReadiness)
    requireValue(ready.length <= 1, "Desktop readiness log is ambiguous")
    if (ready.length === 1) return ready[0]
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
      seedLegacyAccount(database)
    })()
    requireValue(database.query("PRAGMA quick_check").get()?.quick_check === "ok", "legacy beta database is corrupt")
    requireValue(legacyAccountIntact(database), "legacy beta inert account was not seeded exactly")
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

export async function initializePinnedBetaDatabase(path) {
  const root = resolve(import.meta.dir, "../../opencode/migration")
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name <= CURRENT_BETA_MIGRATIONS.at(-1))
    .map((entry) => entry.name)
    .sort()
  requireValue(
    names.length === CURRENT_BETA_MIGRATIONS.length &&
      names.every((name, index) => name === CURRENT_BETA_MIGRATIONS[index]),
    "Pinned beta migration set changed",
  )
  const migrations = await Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(root, name, "migration.sql"), "utf8") })),
  )
  await mkdir(dirname(path), { recursive: true })
  const database = new Database(path)
  try {
    initializePinnedBetaSchema(database, migrations)
  } finally {
    database.close()
  }
}

export function initializePinnedBetaSchema(database, migrations) {
  requireValue(
    Array.isArray(migrations) &&
      migrations.length === CURRENT_BETA_MIGRATIONS.length &&
      migrations.every(
        (migration, index) =>
          migration &&
          Object.keys(migration).length === 2 &&
          migration.name === CURRENT_BETA_MIGRATIONS[index] &&
          typeof migration.sql === "string" &&
          migration.sql.length > 0,
      ),
    "Pinned beta migration input changed",
  )
  database.exec("PRAGMA foreign_keys = ON")
  for (const migration of migrations) database.exec(migration.sql.replaceAll("--> statement-breakpoint", ""))
  requireValue(database.query("PRAGMA quick_check").get()?.quick_check === "ok", "Pinned beta schema is corrupt")
  return true
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
    sentinels_absent: evidence.sentinelsAbsent,
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
  const snapshot = await verifyMigrationSnapshot(
    join(profile.state, "migration-snapshots", journal.snapshotDigest),
    journal.snapshotDigest,
    source.contentFingerprint,
  )
  requireValue(snapshot.verified, "Candidate sealed migration snapshot is corrupt")
  return {
    journalSha256: digest(journalBytes),
    snapshotVerified: snapshot.verified,
    sentinelsAbsent: snapshot.sentinelsAbsent,
  }
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
  const records = []
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
    records.push(bytes)
    expected.push(entry.relative)
  }
  requireValue(
    expected.every((value, index) => index === 0 || expected[index - 1].localeCompare(value) < 0),
    "Candidate migration snapshot records are not canonically ordered",
  )
  const actual = await relativeFiles(join(root, "records"))
  const verified = actual.length === expected.length && actual.every((value, index) => value === expected[index])
  return { verified, sentinelsAbsent: !observeCredentialSentinelPresence(records) }
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
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account', 'account_state', 'control_account', 'session_share')",
      )
      .all()
    requireValue(forbidden.length === 0, "candidate retained credential-bearing tables")
  } finally {
    database.close()
  }
  const credentialStores = await existingStableFiles([
    profile.candidateAuthFile,
    join(profile.root, ".bharatcode", "credentials.json"),
  ])
  const destinationBytes = await boundedTreeBytes([profile.data, profile.config, profile.state])
  return {
    database_quick_check: exactQuickCheck(quickCheck),
    session: exactSessionRows(sessions),
    config: { snapshot: config.snapshot },
    account_state: /Signed out of BharatCode\./u.test(account.stdout) ? "signed-out" : "unknown",
    credential_store_usable: observeCredentialStoreUsability(credentialStores),
    sentinel_present: observeCredentialSentinelPresence(destinationBytes),
  }
}

async function observeRollbackState(runtime, profile) {
  const quickCheck = await runJsonProcess(runtime, ["db", "PRAGMA quick_check", "--format", "json"], profile.env)
  const sessions = await runJsonProcess(
    runtime,
    ["db", `SELECT id, title FROM session WHERE id = '${ACCEPTANCE_SESSION.id}'`, "--format", "json"],
    profile.env,
  )
  const database = new Database(profile.legacyDatabase, { readonly: true })
  const legacyAccount = legacyAccountIntact(database)
  database.close()
  return {
    database_quick_check: exactQuickCheck(quickCheck),
    session: exactSessionRows(sessions),
    config: {
      snapshot: JSON.parse((await readStableFile(profile.legacyConfigFile, "rollback beta config")).toString("utf8"))
        .snapshot,
    },
    legacy_account_intact: legacyAccount,
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

async function observeShareSurface(profile, desktop, remoteDebuggingPort, audit, firewall, egress) {
  const beforeRecords = await observeWindowsProcesses(profile.env)
  const before = validateOwnedProcessTree(beforeRecords, {
    rootPid: desktop.processes.rootPid,
    executable: desktop.executable,
    addressSpaceOverrideArguments: desktop.addressSpaceOverrideArguments,
    requireNetworkService: true,
  })
  requireValue(
    before.utilityPid === desktop.processes.utilityPid &&
      before.networkServicePid === desktop.processes.networkServicePid &&
      samePidSet(before.pids, desktop.processes.pids),
    "Candidate Electron utility or NetworkService changed before ShareNext probe",
  )
  const sidecarPort = Number(new URL(desktop.sidecarOrigin).port)
  const beforeListeners = await observeWindowsLoopbackListeners(profile.env, [remoteDebuggingPort, sidecarPort])
  validateLoopbackListenerOwner(beforeListeners, { port: remoteDebuggingPort, pid: before.rootPid })
  validateLoopbackListenerOwner(beforeListeners, { port: sidecarPort, pid: before.utilityPid })
  const target = selectRendererCdpTarget(await waitForRendererTargets(remoteDebuggingPort), remoteDebuggingPort)
  const reachableControl = parseRendererShareEvaluation(
    await evaluateRendererEgressControl(target.webSocketDebuggerUrl, egress.urls.rendererBefore),
    6,
  )
  validateReachableEgressControl(reachableControl, egress.urls.rendererBefore)
  egress.markRendererReachable()
  await installCandidateNetworkBoundary(desktop.executable, profile.env)
  const unauthenticatedControl = await observeUnauthenticatedSidecarControl(
    desktop.sidecarOrigin,
    profile.projectDirectory,
  )
  const evaluation = parseRendererShareEvaluation(
    await evaluateRendererShareRequests(
      target.webSocketDebuggerUrl,
      desktop.sidecarOrigin,
      profile.projectDirectory,
      egress.urls.rendererBlocked,
    ),
    7,
  )
  const requestSequenceBlocked = egress.requestSequence
  const requestsBlocked = egress.requests
  await delay(2_000)
  egress.markRendererBlocked()
  const postBoundaryControl = await observeHarnessEgressControl(egress)
  validateHarnessEgressControl(postBoundaryControl, egress.urls.harnessAfter)
  egress.markPostBoundaryReachable()
  const afterRecords = await observeWindowsProcesses(profile.env)
  const after = validateOwnedProcessTree(afterRecords, {
    rootPid: desktop.processes.rootPid,
    executable: desktop.executable,
    addressSpaceOverrideArguments: desktop.addressSpaceOverrideArguments,
    requireNetworkService: true,
  })
  requireValue(
    after.utilityPid === before.utilityPid && after.networkServicePid === before.networkServicePid,
    "Candidate Electron utility or NetworkService died or was replaced",
  )
  const afterListeners = await observeWindowsLoopbackListeners(profile.env, [remoteDebuggingPort, sidecarPort])
  validateLoopbackListenerOwner(afterListeners, { port: remoteDebuggingPort, pid: after.rootPid })
  validateLoopbackListenerOwner(afterListeners, { port: sidecarPort, pid: after.utilityPid })
  const blockedEgress = validateBlockedEgressObservation(
    {
      schema: "bharatcode-candidate-egress-control-v1",
      renderer_origin: evaluation.renderer_origin,
      control_urls: egress.urls,
      reachable_control: reachableControl,
      post_boundary_control: postBoundaryControl,
      request_failed: evaluation.egress_request_failed,
      preflight_observed: egress.preflightObserved,
      request_sequence_before: egress.requestSequenceBefore,
      request_sequence_blocked: requestSequenceBlocked,
      request_sequence_after: egress.requestSequence,
      requests_before: egress.requestsBefore,
      requests_blocked: requestsBlocked,
      requests_after: egress.requests,
    },
    firewall,
  )
  const share = validateShareSurfaceObservation({
    schema: "bharatcode-live-electron-share-observation-v1",
    renderer_origin: evaluation.renderer_origin,
    sidecar_origin: evaluation.sidecar_origin,
    target_id: target.id,
    root_pid: before.rootPid,
    utility_pid: before.utilityPid,
    before_pids: before.pids,
    after_pids: after.pids,
    unauthenticated_control: unauthenticatedControl,
    post: evaluation.post,
    delete: evaluation.delete,
    audit_requests: audit.requests,
  })
  return {
    sharenextAbsent: share.sharenextAbsent,
    shareNetworkAttemptAbsent: share.shareNetworkAttemptAbsent && blockedEgress,
    controls: egress.urls,
  }
}

async function observeUnauthenticatedSidecarControl(sidecarOrigin, projectDirectory) {
  const response = await fetch(`${sidecarOrigin}/session/${ACCEPTANCE_SESSION.id}/share`, {
    method: "POST",
    headers: { "x-opencode-directory": projectDirectory },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  })
  return {
    status: response.status,
    content_type: response.headers.get("content-type"),
    body: await response.text(),
    url: response.url,
    redirected: response.redirected,
    www_authenticate: response.headers.get("www-authenticate"),
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

function startLocalEgressControl(controlAddress) {
  requireValue(isPrivateIpv4(controlAddress), "Firewall egress control address is invalid")
  const requestSequence = []
  let requestSequenceBefore = []
  let controls
  const seen = new Set()
  const server = Bun.serve({
    hostname: controlAddress,
    port: 0,
    fetch(request) {
      try {
        const role = Object.entries(controls).find(([, url]) => request.url === url)?.[0]
        requireValue(role, "Firewall egress control URL changed")
        const routed = routeEgressControlRequest(request, controls[role])
        const kind =
          routed.kind === "renderer-preflight"
            ? role === "rendererBefore"
              ? "renderer-preflight"
              : "invalid"
            : role === "harnessBefore" && routed.kind === "harness-get"
              ? "harness-before"
              : role === "rendererBefore" && routed.kind === "renderer-get"
                ? "renderer-before"
                : role === "rendererBlocked" && routed.kind === "renderer-get"
                  ? "renderer-blocked"
                  : role === "harnessAfter" && routed.kind === "harness-get"
                    ? "harness-after"
                    : "invalid"
        requireValue(kind !== "invalid" && !seen.has(kind), "Firewall egress control request was reused")
        seen.add(kind)
        requestSequence.push(kind)
        return routed.response
      } catch {
        requestSequence.push("invalid")
        return new Response(null, { status: 403 })
      }
    },
  })
  controls = createEgressControlUrls(`http://${controlAddress}:${server.port}`)
  return {
    urls: controls,
    get requestsBefore() {
      return requestSequenceBefore.length
    },
    get requests() {
      return requestSequence.length
    },
    get preflightObserved() {
      return requestSequenceBefore.includes("renderer-preflight")
    },
    get requestSequenceBefore() {
      return [...requestSequenceBefore]
    },
    get requestSequence() {
      return [...requestSequence]
    },
    markReachable() {
      requireValue(
        sameStringSequence(requestSequence, ["harness-before"]),
        "Firewall egress control reachability request was not unique",
      )
      return true
    },
    markRendererReachable() {
      requireValue(
        sameStringSequence(requestSequence, ["harness-before", "renderer-before"]),
        "Candidate renderer did not uniquely reach the firewall egress control",
      )
      requestSequenceBefore = [...requestSequence]
      return true
    },
    markRendererBlocked() {
      requireValue(
        requestSequenceBefore.length > 0 && sameStringSequence(requestSequence, requestSequenceBefore),
        "Blocked candidate request reached the firewall egress control",
      )
      return true
    },
    markPostBoundaryReachable() {
      requireValue(
        requestSequenceBefore.length > 0 &&
          sameStringSequence(requestSequence, [...requestSequenceBefore, "harness-after"]),
        "Post-boundary harness control sequence is invalid",
      )
      return true
    },
    stop: async (force) => {
      await server.stop(force)
      return true
    },
  }
}

async function proveEgressControlReachability(egress) {
  const observation = await observeHarnessEgressControl(egress, egress.urls.harnessBefore)
  validateHarnessEgressControl(observation, egress.urls.harnessBefore)
  egress.markReachable()
  return observation
}

async function observeHarnessEgressControl(egress, url = egress.urls.harnessAfter) {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) })
  return {
    status: response.status,
    body: await response.text(),
    url: response.url,
    redirected: response.redirected,
    cache_control: response.headers.get("cache-control"),
    connection: response.headers.get("connection"),
    control_header: response.headers.get("x-bharatcode-egress-control"),
  }
}

async function observeFirewallProfiles(env) {
  const result = await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; $profiles = @(Get-NetFirewallProfile | Sort-Object Name | ForEach-Object { [ordered]@{ name = $_.Name.ToString(); enabled = [bool]$_.Enabled } }); $active = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity.ToString() -ne 'Disconnected' -or $_.IPv6Connectivity.ToString() -ne 'Disconnected' } | ForEach-Object { if ($_.NetworkCategory.ToString() -eq 'DomainAuthenticated') { 'Domain' } else { $_.NetworkCategory.ToString() } } | Sort-Object -Unique); $addresses = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } | ForEach-Object { $_.IPv4Address } | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^(?:10\\.|192\\.168\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.)' } | Sort-Object -Unique); if ($profiles.Count -ne 3 -or $active.Count -lt 1 -or $addresses.Count -ne 1) { throw 'firewall profile or control-address observation is ambiguous' }; [ordered]@{ schema = 'bharatcode-windows-firewall-observation-v1'; active_profiles = @($active); control_address = $addresses[0]; profiles = @($profiles) } | ConvertTo-Json -Compress -Depth 4`,
    ],
    { env, timeout: 30_000 },
  )
  return validateFirewallProfileObservation(JSON.parse(result.stdout.trim()))
}

async function installCandidateNetworkBoundary(executable, env) {
  const name = powershellLiteral(ACCEPTANCE_FIREWALL_RULE)
  const program = powershellLiteral(executable)
  const remoteRanges = ACCEPTANCE_FIREWALL_REMOTE_RANGES.map((value) => `'${powershellLiteral(value)}'`).join(",")
  const result = await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; $remote = @(${remoteRanges}); if (Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue) { throw 'pre-existing acceptance firewall rule' }; try { New-NetFirewallRule -DisplayName '${name}' -Direction Outbound -Action Block -Program '${program}' -RemoteAddress $remote -Profile Any | Out-Null; $rule = Get-NetFirewallRule -DisplayName '${name}'; $app = $rule | Get-NetFirewallApplicationFilter; $address = @($rule | Get-NetFirewallAddressFilter).RemoteAddress; if ($rule.DisplayName -cne '${name}' -or $rule.Enabled.ToString() -cne 'True' -or $rule.Direction.ToString() -cne 'Outbound' -or $rule.Action.ToString() -cne 'Block' -or $rule.Profile.ToString() -cne 'Any' -or $app.Program -ine '${program}' -or $address.Count -ne $remote.Count -or (Compare-Object @($address | Sort-Object) @($remote | Sort-Object))) { throw 'acceptance firewall rule identity changed' }; Write-Output 'BOUNDARY_INSTALLED' } catch { Remove-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue; throw }`,
    ],
    { env, timeout: 30_000 },
  )
  if (!/^BOUNDARY_INSTALLED\r?\n?$/u.test(result.stdout)) {
    await removeCandidateNetworkBoundary(executable, env)
    throw new Error("Candidate public-network boundary was not installed exactly")
  }
  return true
}

async function removeCandidateNetworkBoundary(executable, env) {
  const name = powershellLiteral(ACCEPTANCE_FIREWALL_RULE)
  const program = powershellLiteral(executable)
  await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; $rules = @(Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue); if ($rules.Count -gt 1) { throw 'acceptance firewall rule is ambiguous' }; if ($rules.Count -eq 1) { $app = $rules[0] | Get-NetFirewallApplicationFilter; if ($app.Program -ine '${program}') { throw 'acceptance firewall program identity changed' }; $rules[0] | Remove-NetFirewallRule }; if (Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue) { throw 'acceptance firewall rule survived cleanup' }; Write-Output 'BOUNDARY_ABSENT'`,
    ],
    { env, timeout: 30_000 },
  )
  return true
}

async function reserveLoopbackPort() {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  return port
}

async function waitForRendererTargets(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    if (response?.status === 200) {
      const value = await response.json()
      if (Array.isArray(value) && value.length > 0) return value
    }
    await delay(250)
  }
  throw new Error("Candidate Electron renderer CDP target timed out")
}

async function evaluateRendererEgressControl(webSocketDebuggerUrl, egressControlUrl) {
  const expression = `
    (async () => {
      if (location.origin !== "oc://renderer") throw new Error("renderer origin changed")
      const response = await fetch(${JSON.stringify(egressControlUrl)}, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      })
      return {
        status: response.status,
        body: await response.text(),
        url: response.url,
        redirected: response.redirected,
        cache_control: response.headers.get("cache-control"),
        connection: response.headers.get("connection"),
        control_header: response.headers.get("x-bharatcode-egress-control"),
      }
    })()
  `
  return evaluateRendererExpression(webSocketDebuggerUrl, expression, 6)
}

async function evaluateRendererShareRequests(webSocketDebuggerUrl, sidecarOrigin, projectDirectory, egressControlUrl) {
  const shareUrl = `${sidecarOrigin}/session/${ACCEPTANCE_SESSION.id}/share`
  const expression = `
    (async () => {
      if (location.origin !== "oc://renderer") throw new Error("renderer origin changed")
      const request = async (method) => {
        const response = await fetch(${JSON.stringify(shareUrl)}, {
          method,
          headers: { "x-opencode-directory": ${JSON.stringify(projectDirectory)} },
          redirect: "error",
        })
        return {
          status: response.status,
          content_type: response.headers.get("content-type"),
          body: await response.text(),
          url: response.url,
          redirected: response.redirected,
        }
      }
      return {
        renderer_origin: location.origin,
        sidecar_origin: ${JSON.stringify(sidecarOrigin)},
        egress_request_failed: await (async () => {
          try {
            await fetch(${JSON.stringify(egressControlUrl)}, {
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(5_000),
            })
            return false
          } catch {
            return true
          }
        })(),
        post: await request("POST"),
        delete: await request("DELETE"),
      }
    })()
  `
  return evaluateRendererExpression(webSocketDebuggerUrl, expression, 7)
}

async function evaluateRendererExpression(webSocketDebuggerUrl, expression, id) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => {
      socket.close()
      rejectResponse(new Error("Renderer CDP acceptance evaluation timed out"))
    }, 15_000)
    socket.addEventListener(
      "open",
      () =>
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        ),
      { once: true },
    )
    socket.addEventListener(
      "message",
      (event) => {
        try {
          const value = JSON.parse(String(event.data))
          if (value.id !== id) return
          clearTimeout(timeout)
          socket.close()
          resolveResponse(value)
        } catch {
          clearTimeout(timeout)
          socket.close()
          rejectResponse(new Error("Renderer CDP acceptance response was invalid"))
        }
      },
      { once: false },
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout)
        rejectResponse(new Error("Renderer CDP acceptance evaluation disconnected"))
      },
      { once: true },
    )
  })
  return response
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

export function seedLegacyAccount(database) {
  requireExactDatabaseColumns(database, "account", [
    "id",
    "email",
    "url",
    "access_token",
    "refresh_token",
    "token_expiry",
    "time_created",
    "time_updated",
  ])
  requireExactDatabaseColumns(database, "account_state", ["id", "active_account_id", "active_org_id"])
  database
    .query(
      "INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ACCEPTANCE_ACCOUNT_ID,
      "upgrade-acceptance@example.invalid",
      "https://example.invalid",
      ACCEPTANCE_ACCESS_SENTINEL,
      ACCEPTANCE_REFRESH_SENTINEL,
      ACCEPTANCE_TIME + 86_400_000,
      ACCEPTANCE_TIME,
      ACCEPTANCE_TIME,
    )
  database
    .query("INSERT OR REPLACE INTO account_state (id, active_account_id, active_org_id) VALUES (1, ?, NULL)")
    .run(ACCEPTANCE_ACCOUNT_ID)
}

export function legacyAccountIntact(database) {
  const account = database
    .query(
      "SELECT id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated FROM account WHERE id = ?",
    )
    .get(ACCEPTANCE_ACCOUNT_ID)
  const state = database.query("SELECT id, active_account_id, active_org_id FROM account_state WHERE id = 1").get()
  return (
    account &&
    Object.keys(account).length === 8 &&
    account.id === ACCEPTANCE_ACCOUNT_ID &&
    account.email === "upgrade-acceptance@example.invalid" &&
    account.url === "https://example.invalid" &&
    account.access_token === ACCEPTANCE_ACCESS_SENTINEL &&
    account.refresh_token === ACCEPTANCE_REFRESH_SENTINEL &&
    account.token_expiry === ACCEPTANCE_TIME + 86_400_000 &&
    account.time_created === ACCEPTANCE_TIME &&
    account.time_updated === ACCEPTANCE_TIME &&
    state &&
    Object.keys(state).length === 3 &&
    state.id === 1 &&
    state.active_account_id === ACCEPTANCE_ACCOUNT_ID &&
    state.active_org_id === null
  )
}

async function existingStableFiles(paths) {
  const result = []
  for (const path of paths) {
    if (!(await Bun.file(path).exists())) continue
    result.push(await readStableFile(path, "candidate credential store"))
  }
  return result
}

async function boundedTreeBytes(roots) {
  const paths = []
  for (const root of roots) {
    const files = await relativeFiles(root)
    files.forEach((file) => paths.push(join(root, file)))
  }
  requireValue(paths.length <= 4096, "Candidate destination inventory exceeds its bound")
  const result = []
  let total = 0
  for (const path of paths) {
    const bytes = await readStableFile(path, "candidate destination record")
    total += bytes.byteLength
    requireValue(total <= MAX_CREDENTIAL_SCAN_BYTES, "Candidate destination scan exceeds its byte bound")
    result.push(bytes)
  }
  return result
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

function requireExactDatabaseColumns(database, table, expected) {
  const columns = database
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((item) => item.name)
    .sort()
  const required = [...expected].sort()
  requireValue(
    columns.length === required.length && columns.every((column, index) => column === required[index]),
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

export function safeChildEnvironment(environment) {
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

async function terminateProcessTree(pid, force, env) {
  const result = Bun.spawn(terminationCommand(pid, force), {
    env: safeChildEnvironment(env),
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const code = await Promise.race([result.exited, delay(30_000).then(() => undefined)])
  return code === 0 || code === 128
}

export function terminationCommand(pid, force) {
  requireValue(Number.isSafeInteger(pid) && pid > 0, "Acceptance process identity is invalid")
  if (force) return ["taskkill", "/PID", String(pid), "/T", "/F"]
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$process = Get-Process -Id ${pid} -ErrorAction Stop; if (-not $process.CloseMainWindow()) { exit 3 }`,
  ]
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

async function observeWindowsLoopbackListeners(env, ports) {
  requireValue(
    Array.isArray(ports) &&
      ports.length === 2 &&
      new Set(ports).size === 2 &&
      ports.every((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535),
    "Loopback listener port set is invalid",
  )
  const result = await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ports = @(${ports.join(",")}); Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $ports -contains $_.LocalPort } | Select-Object @{n='local_address';e={$_.LocalAddress}},@{n='local_port';e={$_.LocalPort}},@{n='state';e={$_.State.ToString()}},@{n='owning_process';e={$_.OwningProcess}} | ConvertTo-Json -Compress`,
    ],
    { env, timeout: 30_000 },
  )
  const value = JSON.parse(result.stdout.trim())
  return Array.isArray(value) ? value : [value]
}

function rememberOwnedProcesses(active, rootPid, records) {
  if (!active.has(rootPid)) active.set(rootPid, new Set([rootPid]))
  descendantProcesses(records, rootPid).forEach((item) => active.get(rootPid).add(item.process_id))
}

async function terminateTrackedProcess(rootPid, active, env, graceful = false) {
  const pids = [...(active.get(rootPid) ?? new Set([rootPid]))]
  const requested = await terminateProcessTree(rootPid, !graceful, env)
  if (graceful && requested && (await waitForOwnedProcessesGone(pids, env, 15_000))) {
    active.delete(rootPid)
    return true
  }
  const terminated = graceful ? await terminateProcessTree(rootPid, true, env) : requested
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

function powershellLiteral(value) {
  requireValue(
    typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value),
    "PowerShell literal is invalid",
  )
  return value.replaceAll("'", "''")
}

function requireLoopbackOrigin(value, label) {
  requireValue(
    typeof value === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value),
    `${label} is invalid`,
  )
  const port = Number(new URL(value).port)
  requireValue(Number.isSafeInteger(port) && port >= 1 && port <= 65535, `${label} port is invalid`)
}

function isPrivateIpv4(value) {
  const octets = value.split(".").map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    octets[0] === 127
  )
    return false
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

function validateDisabledShareResponse(value, sidecarOrigin) {
  requireRecord(value, ["body", "content_type", "redirected", "status", "url"], "disabled ShareNext response")
  requireValue(
    value.status === 500 &&
      value.content_type === "application/json" &&
      value.body === '{"_tag":"InternalServerError"}' &&
      value.url === `${sidecarOrigin}/session/${ACCEPTANCE_SESSION.id}/share` &&
      value.redirected === false,
    "Packaged ShareNext endpoint did not return the exact disabled response",
  )
}

function samePidSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length >= 2 &&
    left.length === right.length &&
    left.every((pid, index) => Number.isSafeInteger(pid) && pid > 0 && pid === right[index]) &&
    left.every((pid, index) => index === 0 || left[index - 1] < pid)
  )
}

function sameStringSequence(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === "string" && value === right[index])
  )
}

function validateCandidateNetworkSwitches(switches, expectedAddressSpaceArguments, label) {
  validateAddressSpaceSwitches(switches, expectedAddressSpaceArguments, label)
  const proxySwitches = switches.filter((item) => /^(?:no-)?proxy(?:-|$)/u.test(item.name))
  requireValue(
    proxySwitches.length === 1 &&
      proxySwitches[0].prefix === "--" &&
      proxySwitches[0].rawName === "no-proxy-server" &&
      proxySwitches[0].hasValueSeparator === false,
    `Candidate ${label} proxy boundary changed`,
  )
}

function hasSingleEffectiveSwitch(switches, name, value) {
  const matches = switches.filter((item) => item.name === name)
  return matches.length === 1 && matches[0].hasValueSeparator === true && matches[0].value === value
}

function validateAddressSpaceSwitches(switches, expectedArguments, label) {
  requireValue(Array.isArray(expectedArguments), `Candidate ${label} expected address-space override is invalid`)
  const observed = switches.filter((item) => item.name === "ip-address-space-overrides")
  if (expectedArguments.length === 0) {
    requireValue(observed.length === 0, `Candidate ${label} Chromium address-space override changed`)
    return
  }
  requireValue(
    expectedArguments.length === 1 &&
      /^--ip-address-space-overrides=[^\s"]+$/u.test(expectedArguments[0]) &&
      observed.length === 1 &&
      observed[0].prefix === "--" &&
      observed[0].rawName === "ip-address-space-overrides" &&
      observed[0].hasValueSeparator === true &&
      `--ip-address-space-overrides=${observed[0].value}` === expectedArguments[0],
    `Candidate ${label} Chromium address-space override changed`,
  )
}

function parseWindowsChromiumSwitches(commandLine) {
  const argv = parseWindowsCommandLine(commandLine)
  const switches = []
  let parseSwitches = true
  for (const rawArgument of argv.slice(1)) {
    const argument = rawArgument.trim()
    if (argument === "--") {
      parseSwitches = false
      continue
    }
    if (!parseSwitches) continue
    const prefix = argument.startsWith("--")
      ? "--"
      : argument.startsWith("-")
        ? "-"
        : argument.startsWith("/")
          ? "/"
          : ""
    if (!prefix || argument.length === prefix.length) continue
    const equals = argument.indexOf("=")
    const rawName = argument.slice(prefix.length, equals < 0 ? undefined : equals)
    const name = asciiLower(rawName)
    requireValue(name !== "single-argument", "Owned Windows command line uses the forbidden single-argument switch")
    switches.push({
      prefix,
      rawName,
      name,
      hasValueSeparator: equals >= 0,
      value: equals >= 0 ? argument.slice(equals + 1) : "",
    })
  }
  return switches
}

function parseWindowsCommandLine(commandLine) {
  requireValue(
    typeof commandLine === "string" && commandLine.length >= 1 && commandLine.length <= 32_767,
    "Owned Windows command line is invalid",
  )
  const argv = []
  let index = 0
  while (index < commandLine.length) {
    while (commandLine[index] === " " || commandLine[index] === "\t") index += 1
    if (index >= commandLine.length) break
    let argument = ""
    let quoted = false
    while (index < commandLine.length) {
      if (!quoted && (commandLine[index] === " " || commandLine[index] === "\t")) break
      if (commandLine[index] === "\\") {
        const start = index
        while (commandLine[index] === "\\") index += 1
        const count = index - start
        if (commandLine[index] !== '"') {
          argument += "\\".repeat(count)
          continue
        }
        argument += "\\".repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          argument += '"'
          index += 1
        } else {
          quoted = !quoted
          index += 1
        }
        continue
      }
      if (commandLine[index] === '"') {
        quoted = !quoted
        index += 1
        continue
      }
      argument += commandLine[index]
      index += 1
    }
    requireValue(!quoted, "Owned Windows command line has an unterminated quote")
    argv.push(argument)
  }
  requireValue(argv.length >= 1 && argv[0].length >= 1, "Owned Windows command line has no program")
  return argv
}

function asciiLower(value) {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase())
}

function networkSourceDependencies(value) {
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(networkSourceDependencies)
  return Object.entries(value).flatMap(([key, item]) => {
    if (
      (key === "source_dependency" || key === "source") &&
      item &&
      typeof item === "object" &&
      Number.isSafeInteger(item.id)
    ) {
      return [item.id, ...networkSourceDependencies(item)]
    }
    return networkSourceDependencies(item)
  })
}

function networkStringValues(value) {
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(networkStringValues)
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

export function acceptanceFailureCode(error) {
  const message = error instanceof Error ? error.message : ""
  if (/GitHub identity request|current-beta asset download/iu.test(message)) return "GITHUB_IDENTITY"
  if (/GitHub Actions token/iu.test(message)) return "GITHUB_AUTHORITY"
  if (/Acceptance directory/iu.test(message)) return "ACCEPTANCE_DIRECTORY"
  if (/candidate installer/iu.test(message)) return "CANDIDATE_IDENTITY"
  return "PACKAGED_EXECUTION"
}

if (import.meta.main) {
  runLeanUpgradeAcceptance(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${result.authority}\n`),
    (error) => {
      process.stderr.write(`Packaged upgrade acceptance failed closed [${acceptanceFailureCode(error)}]\n`)
      process.exitCode = 1
    },
  )
}
