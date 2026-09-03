const SHA256 = /^[0-9a-f]{64}$/u
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/u
const SOURCE_SHA = /^[0-9a-f]{40}$/u
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u
const GITHUB_ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u
const ACCEPTED_MANUAL_APPLICATION_SOURCE_SHA = "80c962f4148db531c35abcf4922059d2101c9bcd"

export const PLATFORM_PACKAGE_NAMES = Object.freeze([
  "bharatcode-darwin-arm64",
  "bharatcode-darwin-x64",
  "bharatcode-darwin-x64-baseline",
  "bharatcode-linux-arm64",
  "bharatcode-linux-arm64-musl",
  "bharatcode-linux-x64",
  "bharatcode-linux-x64-baseline",
  "bharatcode-linux-x64-baseline-musl",
  "bharatcode-linux-x64-musl",
  "bharatcode-windows-arm64",
  "bharatcode-windows-x64",
  "bharatcode-windows-x64-baseline",
])

export const REQUIRED_COHORT_KEYS = Object.freeze(
  [
    "cli-bharatcode",
    ...PLATFORM_PACKAGE_NAMES.map((name) => `cli-${name}`),
    "desktop-linux-x64-appimage",
    "desktop-linux-x64-deb",
    "desktop-linux-x64-update-info",
    "desktop-macos-arm64",
    "desktop-macos-arm64-blockmap",
    "desktop-macos-update-info",
    "desktop-macos-x64",
    "desktop-macos-x64-blockmap",
    "desktop-windows-x64",
    "desktop-windows-x64-blockmap",
    "desktop-windows-update-info",
    "upgrade-rollback-windows-x64",
    "wsl-gate",
  ].sort(),
)

export function canonicalLeanJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    requireValue(Number.isSafeInteger(value), "canonical JSON numbers must be safe integers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalLeanJson).join(",")}]`
  requireValue(value && typeof value === "object", "canonical JSON contains an unsupported value")
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalLeanJson(value[key])}`)
    .join(",")}}`
}

export function parseCanonicalLeanJsonBytes(bytes, label, allowTrailingLf = false) {
  requireValue(bytes instanceof Uint8Array, `${label} bytes are invalid`)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  requireValue(!text.startsWith("\uFEFF"), `${label} must not contain a BOM`)
  const body = allowTrailingLf && text.endsWith("\n") ? text.slice(0, -1) : text
  requireValue(!body.endsWith("\n") && !body.endsWith("\r"), `${label} has trailing bytes`)
  const value = JSON.parse(body)
  requireValue(body === canonicalLeanJson(value), `${label} must be canonical JSON without duplicate raw keys`)
  return value
}

export function parseLeanCohortBytes(bytes, bindings) {
  return validateLeanCohort(parseCanonicalLeanJsonBytes(bytes, "lean cohort manifest"), bindings)
}

export function validateLeanUpdaterInfo(value, bindings) {
  exactKeys(bindings, ["files", "label", "version"], "lean updater bindings")
  requireValue(typeof bindings.label === "string" && bindings.label.length > 0, "lean updater label is invalid")
  requirePattern(bindings.version, SEMVER, "expected lean updater version")
  requireValue(Array.isArray(bindings.files) && bindings.files.length > 0, "expected lean updater files are invalid")
  exactKeys(value, ["files", "path", "releaseDate", "sha512", "version"], bindings.label)
  requireValue(value.version === bindings.version, `${bindings.label} version does not match`)
  requireTimestamp(value.releaseDate, `${bindings.label} release`)
  requireValue(
    Array.isArray(value.files) && value.files.length === bindings.files.length,
    `${bindings.label} file set is incomplete`,
  )

  const expectedBySource = new Map()
  const publicUrls = new Set()
  for (const expected of bindings.files) {
    exactKeys(expected, ["bytes", "public_url", "sha512", "source_url"], `${bindings.label} expected file`)
    requireValue(!expectedBySource.has(expected.source_url), `${bindings.label} expected source URL is duplicated`)
    requireValue(!publicUrls.has(expected.public_url), `${bindings.label} expected public URL is duplicated`)
    expectedBySource.set(expected.source_url, expected)
    publicUrls.add(expected.public_url)
  }
  const actualBySource = new Map()
  for (const file of value.files) {
    exactKeys(file, ["sha512", "size", "url"], `${bindings.label} file`)
    const expected = expectedBySource.get(file.url)
    requireValue(expected !== undefined, `${bindings.label} source URL does not match`)
    requireValue(!actualBySource.has(file.url), `${bindings.label} source URL is duplicated`)
    requireFilename(expected.source_url, `${bindings.label} source URL`)
    requireFilename(expected.public_url, `${bindings.label} public URL`)
    requireValue(
      Number.isSafeInteger(expected.bytes) && expected.bytes > 0,
      `${bindings.label} expected size is invalid`,
    )
    requirePattern(expected.sha512, SHA512_BASE64, `${bindings.label} expected SHA-512`)
    requireValue(file.url === expected.source_url, `${bindings.label} source URL does not match`)
    requireValue(file.size === expected.bytes, `${bindings.label} file size does not match`)
    requireValue(file.sha512 === expected.sha512, `${bindings.label} file SHA-512 does not match`)
    actualBySource.set(file.url, file)
  }
  requireValue(actualBySource.size === expectedBySource.size, `${bindings.label} file set is incomplete`)
  const normalizedFiles = bindings.files.map((expected) => {
    const file = actualBySource.get(expected.source_url)
    return { url: expected.public_url, sha512: file.sha512, size: file.size }
  })
  requireValue(value.path === value.files[0].url, `${bindings.label} legacy path does not match`)
  requireValue(value.sha512 === value.files[0].sha512, `${bindings.label} legacy SHA-512 does not match`)
  return {
    version: value.version,
    files: normalizedFiles,
    path: normalizedFiles[0].url,
    sha512: normalizedFiles[0].sha512,
    releaseDate: value.releaseDate,
  }
}

export function validateLeanCohort(value, bindings) {
  exactKeys(bindings, ["run_attempt", "run_id", "source_sha"], "lean cohort bindings")
  exactKeys(
    value,
    [
      "artifacts",
      "candidate_tag",
      "channel",
      "cli_version",
      "completed_at",
      "desktop_version",
      "repository",
      "run_attempt",
      "run_id",
      "schema",
      "source_sha",
      "workflow",
      "wsl_gate_result",
      "wsl_receipt_sha256",
      "wsl_runtime_version",
    ],
    "lean cohort manifest",
  )
  requireValue(value.schema === "bharatcode-next-beta-cohort-v2", "lean cohort schema is invalid")
  requireValue(value.repository === "BharatCode-ai/bharatcode-desktop", "lean cohort repository is invalid")
  requirePattern(bindings.source_sha, SOURCE_SHA, "expected lean cohort source")
  requireValue(value.source_sha === bindings.source_sha, "lean cohort source does not match")
  requireValue(value.candidate_tag === `desktop-beta-${value.desktop_version}`, "lean cohort tag is invalid")
  requirePattern(value.desktop_version, SEMVER, "lean cohort Desktop version")
  requirePattern(value.cli_version, SEMVER, "lean cohort CLI version")
  requirePattern(value.wsl_runtime_version, SEMVER, "lean cohort WSL runtime version")
  requireValue(
    value.wsl_runtime_version === value.desktop_version,
    "lean cohort WSL runtime version must match the Desktop staging contract",
  )
  requireValue(value.channel === "beta", "lean cohort channel is invalid")
  requireValue(
    value.workflow === ".github/workflows/bharatcode-next-beta-candidate.yml",
    "lean cohort workflow is invalid",
  )
  requirePattern(bindings.run_id, POSITIVE_DECIMAL, "expected lean cohort run ID")
  requirePattern(bindings.run_attempt, POSITIVE_DECIMAL, "expected lean cohort run attempt")
  requireValue(value.run_id === bindings.run_id, "lean cohort run ID does not match")
  requireValue(value.run_attempt === bindings.run_attempt, "lean cohort run attempt does not match")
  requireValue(
    value.wsl_gate_result === "PASS" || value.wsl_gate_result === "OWNER_WAIVED",
    "lean cohort WSL gate result is invalid",
  )
  requirePattern(value.wsl_receipt_sha256, SHA256, "lean cohort WSL receipt SHA-256")
  requireTimestamp(value.completed_at, "lean cohort completion")
  requireValue(
    Array.isArray(value.artifacts) && value.artifacts.length === REQUIRED_COHORT_KEYS.length,
    "lean cohort artifact set is incomplete",
  )

  const filenames = new Set()
  const attestationFilenames = new Set()
  value.artifacts.forEach((artifact, index) => {
    validateArtifact(artifact, REQUIRED_COHORT_KEYS[index], value, filenames, attestationFilenames)
  })
  const wslReceipt = value.artifacts.find((artifact) => artifact.key === "wsl-gate")
  requireValue(wslReceipt?.sha256 === value.wsl_receipt_sha256, "lean cohort WSL receipt digest does not match")
  requireValue(
    wslReceipt?.filename ===
      (value.wsl_gate_result === "PASS"
        ? "bharatcode-wsl-scenarios-9-10.json"
        : "bharatcode-wsl-acceptance-waiver.json"),
    "lean cohort WSL receipt filename does not match its result",
  )
  requireValue(!/opencode/iu.test(canonicalLeanJson(value)), "lean cohort contains a forbidden public identity")
  return structuredClone(value)
}

export function validateLeanWslReceipt(value, bindings) {
  exactKeys(
    bindings,
    ["desktop_sha256", "run_attempt", "run_id", "runtime_manifest_sha256", "source_sha"],
    "lean WSL receipt bindings",
  )
  exactKeys(
    value,
    [
      "completed_at",
      "desktop_sha256",
      "github",
      "identity",
      "result",
      "runtime",
      "runtime_manifest_sha256",
      "scenarios",
      "schema",
      "source_sha",
    ],
    "lean WSL receipt",
  )
  requireValue(value.schema === "bharatcode-wsl-scenarios-9-10-v1", "lean WSL receipt schema is invalid")
  requireValue(value.result === "PASS", "lean WSL receipt result is invalid")
  requirePattern(bindings.source_sha, SOURCE_SHA, "expected lean WSL source")
  requireValue(value.source_sha === bindings.source_sha, "lean WSL receipt source does not match")
  requirePattern(bindings.desktop_sha256, SHA256, "expected lean WSL Desktop SHA-256")
  requirePattern(bindings.runtime_manifest_sha256, SHA256, "expected lean WSL runtime manifest SHA-256")
  requireValue(value.desktop_sha256 === bindings.desktop_sha256, "lean WSL Desktop digest does not match")
  requireValue(
    value.runtime_manifest_sha256 === bindings.runtime_manifest_sha256,
    "lean WSL runtime manifest digest does not match",
  )
  exactKeys(
    value.runtime,
    ["executed_sha256", "executed_source_sha", "manifest_sha256", "manifest_source_sha"],
    "lean WSL runtime",
  )
  requireValue(
    value.runtime.manifest_source_sha === value.source_sha && value.runtime.executed_source_sha === value.source_sha,
    "lean WSL runtime source does not match",
  )
  requirePattern(value.runtime.manifest_sha256, SHA256, "lean WSL manifest runtime SHA-256")
  requireValue(
    value.runtime.executed_sha256 === value.runtime.manifest_sha256,
    "lean WSL executed runtime digest does not match",
  )
  exactKeys(value.github, ["run_attempt", "run_id"], "lean WSL GitHub identity")
  requirePattern(bindings.run_id, POSITIVE_DECIMAL, "expected lean WSL run ID")
  requirePattern(bindings.run_attempt, POSITIVE_DECIMAL, "expected lean WSL run attempt")
  requireValue(
    Number.isSafeInteger(value.github.run_id) && String(value.github.run_id) === bindings.run_id,
    "lean WSL receipt run ID does not match",
  )
  requireValue(
    Number.isSafeInteger(value.github.run_attempt) && String(value.github.run_attempt) === bindings.run_attempt,
    "lean WSL receipt run attempt does not match",
  )
  exactKeys(value.identity, ["distro_sha256", "uid", "user_sha256"], "lean WSL host identity")
  requirePattern(value.identity.distro_sha256, SHA256, "lean WSL distribution identity")
  requirePattern(value.identity.user_sha256, SHA256, "lean WSL user identity")
  requireValue(Number.isSafeInteger(value.identity.uid) && value.identity.uid > 0, "lean WSL UID must be non-root")
  exactKeys(value.scenarios, ["10", "9"], "lean WSL scenarios")
  requireValue(value.scenarios["9"] === true && value.scenarios["10"] === true, "lean WSL scenarios are incomplete")
  requireTimestamp(value.completed_at, "lean WSL receipt completion")
  requireValue(!/opencode/iu.test(canonicalLeanJson(value)), "lean WSL receipt contains a forbidden public identity")
  return structuredClone(value)
}

export function validateLeanWslWaiver(value, bindings) {
  exactKeys(
    bindings,
    ["desktop_sha256", "run_attempt", "run_id", "runtime_manifest_sha256", "source_sha"],
    "lean WSL waiver bindings",
  )
  exactKeys(
    value,
    [
      "accepted_application_source_sha",
      "completed_at",
      "desktop_sha256",
      "github",
      "manual_acceptance",
      "reason",
      "result",
      "runtime_manifest_sha256",
      "schema",
      "source_sha",
    ],
    "lean WSL waiver",
  )
  requireValue(value.schema === "bharatcode-wsl-acceptance-waiver-v1", "lean WSL waiver schema is invalid")
  requireValue(value.result === "OWNER_WAIVED", "lean WSL waiver result is invalid")
  requireValue(
    value.reason === "FORMAL_WINDOWS_WSL2_VM_ACCEPTANCE_NOT_RUN_BY_OWNER_DECISION",
    "lean WSL waiver reason is invalid",
  )
  requireValue(
    value.manual_acceptance === "INSTALLED_WINDOWS_STARTUP_SIGNIN_PROJECT_MODELS_SESSION_RESTORE_USER_CONFIRMED",
    "lean WSL waiver manual acceptance is invalid",
  )
  requireValue(
    value.accepted_application_source_sha === ACCEPTED_MANUAL_APPLICATION_SOURCE_SHA,
    "lean WSL waiver accepted application source is invalid",
  )
  requirePattern(bindings.source_sha, SOURCE_SHA, "expected lean WSL waiver source")
  requireValue(value.source_sha === bindings.source_sha, "lean WSL waiver source does not match")
  requirePattern(bindings.desktop_sha256, SHA256, "expected lean WSL waiver Desktop SHA-256")
  requirePattern(bindings.runtime_manifest_sha256, SHA256, "expected lean WSL waiver runtime manifest SHA-256")
  requireValue(value.desktop_sha256 === bindings.desktop_sha256, "lean WSL waiver Desktop digest does not match")
  requireValue(
    value.runtime_manifest_sha256 === bindings.runtime_manifest_sha256,
    "lean WSL waiver runtime manifest digest does not match",
  )
  exactKeys(value.github, ["actor", "run_attempt", "run_id"], "lean WSL waiver GitHub identity")
  requirePattern(value.github.actor, GITHUB_ACTOR, "lean WSL waiver GitHub actor")
  requirePattern(bindings.run_id, POSITIVE_DECIMAL, "expected lean WSL waiver run ID")
  requirePattern(bindings.run_attempt, POSITIVE_DECIMAL, "expected lean WSL waiver run attempt")
  requireValue(
    Number.isSafeInteger(value.github.run_id) && String(value.github.run_id) === bindings.run_id,
    "lean WSL waiver run ID does not match",
  )
  requireValue(
    Number.isSafeInteger(value.github.run_attempt) && String(value.github.run_attempt) === bindings.run_attempt,
    "lean WSL waiver run attempt does not match",
  )
  requireTimestamp(value.completed_at, "lean WSL waiver completion")
  requireValue(!/opencode/iu.test(canonicalLeanJson(value)), "lean WSL waiver contains a forbidden public identity")
  return structuredClone(value)
}

function validateArtifact(value, expectedKey, manifest, filenames, attestationFilenames) {
  exactKeys(
    value,
    ["arch", "artifact_attestation", "bytes", "completed_at", "filename", "key", "platform", "sha256", "signing"],
    `lean cohort artifact ${expectedKey}`,
  )
  requireValue(value.key === expectedKey, "lean cohort artifact keys are missing, duplicated, or unsorted")
  const expected = expectedArtifactIdentity(expectedKey, manifest)
  requireValue(
    value.platform === expected.platform && value.arch === expected.arch,
    `lean cohort ${expectedKey} platform is invalid`,
  )
  requireValue(value.signing === expected.signing, `lean cohort ${expectedKey} signing result is invalid`)
  requireFilename(value.filename, `lean cohort ${expectedKey} filename`)
  if (expected.filename !== undefined) {
    requireValue(value.filename === expected.filename, `lean cohort ${expectedKey} filename is invalid`)
  }
  requireValue(!filenames.has(value.filename), "lean cohort artifact filename is duplicated")
  filenames.add(value.filename)
  requireValue(Number.isSafeInteger(value.bytes) && value.bytes > 0, `lean cohort ${expectedKey} byte size is invalid`)
  requirePattern(value.sha256, SHA256, `lean cohort ${expectedKey} SHA-256`)
  requireTimestamp(value.completed_at, `lean cohort ${expectedKey} completion`)
  requireValue(
    Date.parse(value.completed_at) <= Date.parse(manifest.completed_at),
    `lean cohort ${expectedKey} completed too late`,
  )
  exactKeys(
    value.artifact_attestation,
    ["bytes", "filename", "predicate_type", "sha256", "subject_sha256"],
    `lean cohort ${expectedKey} attestation`,
  )
  requireFilename(value.artifact_attestation.filename, `lean cohort ${expectedKey} attestation filename`)
  requireValue(
    !attestationFilenames.has(value.artifact_attestation.filename),
    "lean cohort attestation filename is duplicated",
  )
  attestationFilenames.add(value.artifact_attestation.filename)
  requireValue(
    Number.isSafeInteger(value.artifact_attestation.bytes) && value.artifact_attestation.bytes > 0,
    `lean cohort ${expectedKey} attestation byte size is invalid`,
  )
  requireValue(
    typeof value.artifact_attestation.sha256 === "string" && SHA256.test(value.artifact_attestation.sha256),
    `lean cohort ${expectedKey} attestation bundle SHA-256 is invalid`,
  )
  requireValue(
    value.artifact_attestation.subject_sha256 === value.sha256,
    `lean cohort ${expectedKey} attestation subject digest does not match`,
  )
  requireValue(
    value.artifact_attestation.predicate_type === "https://slsa.dev/provenance/v1",
    `lean cohort ${expectedKey} attestation predicate is invalid`,
  )
}

function expectedArtifactIdentity(key, manifest) {
  if (key === "desktop-windows-x64") return { platform: "windows", arch: "x64", signing: "unsigned" }
  if (key === "desktop-windows-x64-blockmap") {
    return {
      platform: "windows",
      arch: "x64",
      signing: "not-applicable",
      filename: "bharatcode-desktop-next-beta-win-x64.exe.blockmap",
    }
  }
  if (key === "desktop-windows-update-info") {
    return { platform: "windows", arch: "x64", signing: "not-applicable", filename: "beta.yml" }
  }
  if (key === "desktop-macos-arm64") {
    return { platform: "macos", arch: "arm64", signing: "apple-notarized-stapled" }
  }
  if (key === "desktop-macos-arm64-blockmap") {
    return {
      platform: "macos",
      arch: "arm64",
      signing: "not-applicable",
      filename: "bharatcode-desktop-next-beta-mac-arm64.zip.blockmap",
    }
  }
  if (key === "desktop-macos-update-info") {
    return { platform: "macos", arch: "universal", signing: "not-applicable", filename: "beta-mac.yml" }
  }
  if (key === "desktop-macos-x64") {
    return { platform: "macos", arch: "x64", signing: "apple-notarized-stapled" }
  }
  if (key === "desktop-macos-x64-blockmap") {
    return {
      platform: "macos",
      arch: "x64",
      signing: "not-applicable",
      filename: "bharatcode-desktop-next-beta-mac-x64.zip.blockmap",
    }
  }
  if (key === "desktop-linux-x64-update-info") {
    return { platform: "linux", arch: "x64", signing: "not-applicable", filename: "beta-linux.yml" }
  }
  if (key.startsWith("desktop-linux-")) return { platform: "linux", arch: "x64", signing: "not-applicable" }
  if (key === "wsl-gate") {
    return {
      platform: "windows-wsl2",
      arch: "x64",
      signing: manifest.wsl_gate_result === "PASS" ? "acceptance-receipt" : "owner-waiver-receipt",
    }
  }
  if (key === "upgrade-rollback-windows-x64") {
    return { platform: "windows", arch: "x64", signing: "acceptance-receipt" }
  }
  if (key === "cli-bharatcode") return { platform: "npm", arch: "universal", signing: "not-applicable" }
  const platform = key.includes("-darwin-") ? "macos" : key.includes("-windows-") ? "windows" : "linux"
  return { platform, arch: key.includes("-arm64") ? "arm64" : "x64", signing: "not-applicable" }
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

function requireFilename(value, label) {
  requireValue(typeof value === "string" && SAFE_FILENAME.test(value), `${label} is invalid or mutable`)
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
