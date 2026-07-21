const SOURCE_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u
const CLASSIFICATION = "PRELIMINARY_UNSIGNED"

export function validatePreliminaryUnsignedWslReceipt(value, bindings) {
  exactKeys(
    bindings,
    [
      "adapter_sha256",
      "evidence_script_sha256",
      "harness_sha256",
      "installed_desktop_bytes",
      "installed_desktop_sha256",
      "run_attempt",
      "run_id",
      "runtime_manifest_sha256",
      "runtime_sha256",
      "source_sha",
      "unsigned_installer_bytes",
      "unsigned_installer_sha256",
      "validator_sha256",
    ],
    "preliminary WSL bindings",
  )
  exactKeys(
    value,
    [
      "completed_at",
      "cleanup_complete",
      "composable",
      "controller_inputs",
      "evidence_class",
      "github",
      "harness",
      "identity",
      "installed_desktop",
      "promotable",
      "provenance_status",
      "repository",
      "result",
      "runtime",
      "runtime_manifest_sha256",
      "scenarios",
      "schema",
      "signature_status",
      "source_sha",
      "unsigned_installer",
      "workflow",
    ],
    "preliminary WSL receipt",
  )
  requireValue(value.schema === "bharatcode-wsl-preliminary-unsigned-v1", "preliminary WSL schema is invalid")
  for (const field of ["evidence_class", "result", "signature_status", "provenance_status"]) {
    requireValue(value[field] === CLASSIFICATION, `preliminary WSL ${field} is invalid`)
  }
  requireValue(value.cleanup_complete === true, "preliminary WSL cleanup must be complete")
  requireValue(value.promotable === false, "preliminary WSL evidence must not be promotable")
  requireValue(value.composable === false, "preliminary WSL evidence must not be composable")
  exactKeys(
    value.controller_inputs,
    ["adapter_sha256", "evidence_script_sha256", "validator_sha256"],
    "preliminary WSL controller inputs",
  )
  for (const field of ["adapter_sha256", "evidence_script_sha256", "validator_sha256"]) {
    requirePattern(bindings[field], SHA256, `expected preliminary WSL ${field}`)
    requireValue(value.controller_inputs[field] === bindings[field], `preliminary WSL ${field} does not match`)
  }
  requireValue(value.repository === "BharatCode-ai/bharatcode-desktop", "preliminary WSL repository is invalid")
  requireValue(
    value.workflow === ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
    "preliminary WSL workflow is invalid",
  )

  requirePattern(bindings.source_sha, SOURCE_SHA, "expected preliminary WSL source")
  requireValue(value.source_sha === bindings.source_sha, "preliminary WSL source does not match")
  exactKeys(value.github, ["run_attempt", "run_id"], "preliminary WSL GitHub identity")
  requirePositiveIdentity(value.github.run_id, bindings.run_id, "run ID")
  requirePositiveIdentity(value.github.run_attempt, bindings.run_attempt, "run attempt")

  validateArtifact(
    value.unsigned_installer,
    "bharatcode-desktop-preliminary-unsigned-test-win-x64.exe",
    bindings.unsigned_installer_bytes,
    bindings.unsigned_installer_sha256,
    "unsigned installer",
  )
  validateArtifact(
    value.installed_desktop,
    "BharatCode Beta.exe",
    bindings.installed_desktop_bytes,
    bindings.installed_desktop_sha256,
    "installed Desktop",
  )
  requirePattern(bindings.runtime_manifest_sha256, SHA256, "expected preliminary runtime manifest SHA-256")
  requireValue(
    value.runtime_manifest_sha256 === bindings.runtime_manifest_sha256,
    "preliminary runtime manifest digest does not match",
  )

  exactKeys(
    value.runtime,
    ["executed_sha256", "executed_source_sha", "manifest_sha256", "manifest_source_sha"],
    "preliminary WSL runtime",
  )
  requireValue(
    value.runtime.manifest_source_sha === value.source_sha && value.runtime.executed_source_sha === value.source_sha,
    "preliminary WSL runtime source does not match",
  )
  requirePattern(value.runtime.manifest_sha256, SHA256, "preliminary WSL manifest runtime SHA-256")
  requirePattern(bindings.runtime_sha256, SHA256, "expected preliminary WSL runtime SHA-256")
  requireValue(
    value.runtime.executed_sha256 === value.runtime.manifest_sha256 &&
      value.runtime.executed_sha256 === bindings.runtime_sha256,
    "preliminary WSL executed runtime digest does not match",
  )

  exactKeys(value.harness, ["authority", "contract", "contract_sha256"], "preliminary WSL harness")
  requireValue(
    value.harness.contract === "packages/desktop/scripts/wsl-windows-acceptance.mjs",
    "preliminary WSL harness contract is invalid",
  )
  requirePattern(bindings.harness_sha256, SHA256, "expected preliminary WSL harness SHA-256")
  requireValue(
    value.harness.contract_sha256 === bindings.harness_sha256,
    "preliminary WSL harness digest does not match",
  )
  requireValue(value.harness.authority === "DIAGNOSTIC", "preliminary WSL harness authority is invalid")

  exactKeys(value.identity, ["distro_sha256", "uid", "user_sha256"], "preliminary WSL host identity")
  requirePattern(value.identity.distro_sha256, SHA256, "preliminary WSL distribution identity")
  requirePattern(value.identity.user_sha256, SHA256, "preliminary WSL user identity")
  requireValue(
    Number.isSafeInteger(value.identity.uid) && value.identity.uid > 0,
    "preliminary WSL UID must be non-root",
  )
  exactKeys(value.scenarios, ["10", "9"], "preliminary WSL scenarios")
  requireValue(
    value.scenarios["9"] === true && value.scenarios["10"] === true,
    "preliminary WSL scenarios are incomplete",
  )
  requireTimestamp(value.completed_at, "preliminary WSL completion")
  requireValue(
    !/password|secret|token|credential|authorization|cookie/iu.test(JSON.stringify(value)),
    "preliminary WSL receipt contains a forbidden secret field",
  )
  return structuredClone(value)
}

export function canonicalPreliminaryUnsignedWslJson(value, bindings) {
  const validated = validatePreliminaryUnsignedWslReceipt(value, bindings)
  return `${JSON.stringify(projectReceipt(validated))}\n`
}

export function parsePreliminaryUnsignedWslJson(raw, bindings) {
  return validatePreliminaryUnsignedWslReceipt(parseClosedJson(raw, "preliminary WSL receipt"), bindings)
}

function projectReceipt(value) {
  return {
    schema: value.schema,
    evidence_class: value.evidence_class,
    result: value.result,
    signature_status: value.signature_status,
    provenance_status: value.provenance_status,
    cleanup_complete: value.cleanup_complete,
    promotable: value.promotable,
    composable: value.composable,
    controller_inputs: {
      adapter_sha256: value.controller_inputs.adapter_sha256,
      evidence_script_sha256: value.controller_inputs.evidence_script_sha256,
      validator_sha256: value.controller_inputs.validator_sha256,
    },
    repository: value.repository,
    workflow: value.workflow,
    source_sha: value.source_sha,
    github: { run_id: value.github.run_id, run_attempt: value.github.run_attempt },
    unsigned_installer: {
      filename: value.unsigned_installer.filename,
      bytes: value.unsigned_installer.bytes,
      sha256: value.unsigned_installer.sha256,
    },
    installed_desktop: {
      filename: value.installed_desktop.filename,
      bytes: value.installed_desktop.bytes,
      sha256: value.installed_desktop.sha256,
    },
    runtime_manifest_sha256: value.runtime_manifest_sha256,
    runtime: {
      manifest_source_sha: value.runtime.manifest_source_sha,
      executed_source_sha: value.runtime.executed_source_sha,
      manifest_sha256: value.runtime.manifest_sha256,
      executed_sha256: value.runtime.executed_sha256,
    },
    harness: {
      contract: value.harness.contract,
      contract_sha256: value.harness.contract_sha256,
      authority: value.harness.authority,
    },
    identity: {
      distro_sha256: value.identity.distro_sha256,
      user_sha256: value.identity.user_sha256,
      uid: value.identity.uid,
    },
    scenarios: { 9: value.scenarios["9"], 10: value.scenarios["10"] },
    completed_at: value.completed_at,
  }
}

function validateArtifact(value, filename, expectedBytes, expectedSha256, label) {
  exactKeys(value, ["bytes", "filename", "sha256"], `preliminary WSL ${label}`)
  requireValue(value.filename === filename, `preliminary WSL ${label} filename is invalid`)
  requireValue(
    Number.isSafeInteger(expectedBytes) && expectedBytes > 0,
    `expected preliminary WSL ${label} bytes are invalid`,
  )
  requireValue(value.bytes === expectedBytes, `preliminary WSL ${label} byte size does not match`)
  requirePattern(expectedSha256, SHA256, `expected preliminary WSL ${label} SHA-256`)
  requireValue(value.sha256 === expectedSha256, `preliminary WSL ${label} digest does not match`)
}

function requirePositiveIdentity(value, expected, label) {
  requirePattern(expected, POSITIVE_DECIMAL, `expected preliminary WSL ${label}`)
  requireValue(
    Number.isSafeInteger(value) && value > 0 && String(value) === expected,
    `preliminary WSL ${label} does not match`,
  )
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
  const closed = [...expected].sort()
  requireValue(
    actual.length === closed.length && actual.every((key, index) => key === closed[index]),
    `${label} keys are invalid`,
  )
}

function parseClosedJson(raw, label) {
  let source
  if (typeof raw === "string") source = raw
  else if (raw instanceof ArrayBuffer) source = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  else if (raw instanceof Uint8Array) source = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  else throw new Error(`${label} raw JSON is invalid`)

  let index = 0
  const skipWhitespace = () => {
    while (index < source.length && /[\t\n\r ]/u.test(source[index])) index += 1
  }
  const parseString = () => {
    requireValue(source[index] === '"', `${label} JSON string is invalid`)
    const start = index
    index += 1
    while (index < source.length) {
      const code = source.charCodeAt(index)
      if (source[index] === '"') {
        index += 1
        return JSON.parse(source.slice(start, index))
      }
      requireValue(code >= 0x20, `${label} JSON string is invalid`)
      if (source[index] === "\\") {
        index += 1
        requireValue(index < source.length && /["\\/bfnrtu]/u.test(source[index]), `${label} JSON escape is invalid`)
        if (source[index] === "u") {
          requireValue(/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 1, index + 5)), `${label} JSON escape is invalid`)
          index += 4
        }
      }
      index += 1
    }
    throw new Error(`${label} JSON string is invalid`)
  }
  const parseValue = () => {
    skipWhitespace()
    if (source[index] === "{") {
      index += 1
      skipWhitespace()
      const keys = new Set()
      if (source[index] === "}") {
        index += 1
        return
      }
      while (index < source.length) {
        const key = parseString()
        requireValue(!keys.has(key), `${label} contains a duplicate key: ${key}`)
        keys.add(key)
        skipWhitespace()
        requireValue(source[index] === ":", `${label} JSON object is invalid`)
        index += 1
        parseValue()
        skipWhitespace()
        if (source[index] === "}") {
          index += 1
          return
        }
        requireValue(source[index] === ",", `${label} JSON object is invalid`)
        index += 1
        skipWhitespace()
      }
      throw new Error(`${label} JSON object is invalid`)
    }
    if (source[index] === "[") {
      index += 1
      skipWhitespace()
      if (source[index] === "]") {
        index += 1
        return
      }
      while (index < source.length) {
        parseValue()
        skipWhitespace()
        if (source[index] === "]") {
          index += 1
          return
        }
        requireValue(source[index] === ",", `${label} JSON array is invalid`)
        index += 1
      }
      throw new Error(`${label} JSON array is invalid`)
    }
    if (source[index] === '"') {
      parseString()
      return
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length
        return
      }
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0]
    requireValue(number, `${label} JSON value is invalid`)
    index += number.length
  }
  parseValue()
  skipWhitespace()
  requireValue(index === source.length, `${label} JSON has trailing content`)
  return JSON.parse(source)
}

function requirePattern(value, pattern, label) {
  requireValue(typeof value === "string" && pattern.test(value), `${label} is invalid`)
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
