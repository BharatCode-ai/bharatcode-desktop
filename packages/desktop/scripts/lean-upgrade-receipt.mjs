import { canonicalLeanJson, parseCanonicalLeanJsonBytes } from "../../opencode/script/lean-cohort.mjs"

const SHA256 = /^[0-9a-f]{64}$/u
const SOURCE_SHA = /^[0-9a-f]{40}$/u
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u
const CURRENT_BETA = Object.freeze({
  schema: "bharatcode-current-beta-fixture-v1",
  repository: "BharatCode-ai/bharatcode-desktop",
  release_id: "351974071",
  tag: "desktop-beta-2026-07-10-account-auth-001",
  source_sha: "01737c1cb123909c2ca0626d3fc2ce475fe7c599",
  assets: Object.freeze([
    Object.freeze({
      key: "desktop-windows-x64",
      asset_id: "472279670",
      filename: "bharatcode-desktop-win-x64.exe",
      bytes: 119910146,
      sha256: "cb7d4252441da3704d915c3a3afa908ea04efa6e6cd5552fe683aef65e9982e1",
    }),
  ]),
})
const CHECK_KEYS = Object.freeze([
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
])

export { canonicalLeanJson }

export function parseCurrentBetaFixtureBytes(bytes) {
  return validateCurrentBetaFixture(parseCanonicalLeanJsonBytes(bytes, "current-beta fixture", true))
}

export function validateCurrentBetaFixture(value) {
  exactKeys(value, ["assets", "release_id", "repository", "schema", "source_sha", "tag"], "current-beta fixture")
  requireValue(Array.isArray(value.assets) && value.assets.length === 1, "current-beta asset set is invalid")
  validateAsset(value.assets[0], "current-beta asset")
  requireValue(
    canonicalLeanJson(value) === canonicalLeanJson(CURRENT_BETA),
    "current-beta release or asset identity changed",
  )
  return structuredClone(value)
}

export function parseLeanUpgradeReceiptBytes(bytes, bindings) {
  return validateLeanUpgradeReceipt(parseCanonicalLeanJsonBytes(bytes, "lean upgrade receipt", true), bindings)
}

export function validateLeanUpgradeReceipt(value, bindings) {
  exactKeys(bindings, ["current_beta", "run_attempt", "run_id", "source_sha"], "lean upgrade bindings")
  const currentBeta = validateCurrentBetaFixture(bindings.current_beta)
  exactKeys(
    value,
    [
      "candidate",
      "candidate_tag",
      "checks",
      "completed_at",
      "current_beta",
      "github",
      "host",
      "repository",
      "result",
      "schema",
      "source_sha",
    ],
    "lean upgrade receipt",
  )
  requireValue(value.schema === "bharatcode-lean-upgrade-rollback-receipt-v1", "lean upgrade schema is invalid")
  requireValue(value.result === "PASS", "lean upgrade result is invalid")
  requireValue(value.repository === "BharatCode-ai/bharatcode-desktop", "lean upgrade repository is invalid")
  requirePattern(bindings.source_sha, SOURCE_SHA, "expected lean upgrade source")
  requireValue(value.source_sha === bindings.source_sha, "lean upgrade source does not match")
  requireValue(
    value.candidate_tag === `next-beta-${value.source_sha.slice(0, 12)}`,
    "lean upgrade candidate tag is invalid",
  )
  exactKeys(value.github, ["run_attempt", "run_id"], "lean upgrade GitHub identity")
  requirePattern(bindings.run_id, POSITIVE_DECIMAL, "expected lean upgrade run ID")
  requirePattern(bindings.run_attempt, POSITIVE_DECIMAL, "expected lean upgrade run attempt")
  requireValue(value.github.run_id === bindings.run_id, "lean upgrade run ID does not match")
  requireValue(value.github.run_attempt === bindings.run_attempt, "lean upgrade run attempt does not match")
  exactKeys(value.host, ["arch", "os", "runner_image"], "lean upgrade host")
  requireValue(value.host.os === "windows" && value.host.arch === "x64", "lean upgrade requires a Windows x64 host")
  requireValue(
    typeof value.host.runner_image === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.host.runner_image),
    "lean upgrade runner image is invalid",
  )
  exactKeys(value.current_beta, ["asset", "release_id", "source_sha", "tag"], "lean upgrade current-beta identity")
  validateAsset(value.current_beta.asset, "lean upgrade current-beta asset")
  requireValue(
    canonicalLeanJson(value.current_beta) ===
      canonicalLeanJson({
        release_id: currentBeta.release_id,
        tag: currentBeta.tag,
        source_sha: currentBeta.source_sha,
        asset: currentBeta.assets[0],
      }),
    "lean upgrade current-beta release or asset identity changed",
  )
  exactKeys(value.candidate, ["bytes", "filename", "key", "sha256"], "lean upgrade candidate artifact")
  requireValue(value.candidate.key === "desktop-windows-x64", "lean upgrade candidate artifact key is invalid")
  requireValue(
    typeof value.candidate.filename === "string" && SAFE_FILENAME.test(value.candidate.filename),
    "lean upgrade candidate filename is invalid or mutable",
  )
  requireValue(
    Number.isSafeInteger(value.candidate.bytes) && value.candidate.bytes > 0,
    "lean upgrade candidate size is invalid",
  )
  requirePattern(value.candidate.sha256, SHA256, "lean upgrade candidate SHA-256")
  exactKeys(value.checks, CHECK_KEYS, "lean upgrade checks")
  requireValue(
    Object.values(value.checks).every((item) => item === true),
    "lean upgrade checks, ShareNext, or network gate failed",
  )
  requireTimestamp(value.completed_at, "lean upgrade completion")
  requireValue(!containsForbiddenValue(value), "lean upgrade receipt contains a forbidden public or secret value")
  return structuredClone(value)
}

function validateAsset(value, label) {
  exactKeys(value, ["asset_id", "bytes", "filename", "key", "sha256"], label)
  requireValue(value.key === "desktop-windows-x64", `${label} key is invalid`)
  requirePattern(value.asset_id, POSITIVE_DECIMAL, `${label} ID`)
  requireValue(typeof value.filename === "string" && SAFE_FILENAME.test(value.filename), `${label} filename is invalid`)
  requireValue(Number.isSafeInteger(value.bytes) && value.bytes > 0, `${label} byte size is invalid`)
  requirePattern(value.sha256, SHA256, `${label} SHA-256`)
}

function containsForbiddenValue(value) {
  if (typeof value === "string") return /opencode|token|password|secret|authorization|cookie/iu.test(value)
  if (Array.isArray(value)) return value.some(containsForbiddenValue)
  if (!value || typeof value !== "object") return false
  return Object.values(value).some(containsForbiddenValue)
}

function requireTimestamp(value, label) {
  requireValue(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} timestamp is invalid`,
  )
}

function exactKeys(value, expected, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  requireValue(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} keys are invalid`,
  )
}

function requirePattern(value, pattern, label) {
  requireValue(typeof value === "string" && pattern.test(value), `${label} is invalid`)
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
