const SOURCE_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u
const PROVIDER = /^[a-z][a-z0-9-]{2,63}$/u
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/u
const CLASSIFICATION = "PRELIMINARY_UNSIGNED"
const REPOSITORY = "BharatCode-ai/bharatcode-desktop"
const WORKFLOW = ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml"
const MAX_ADMISSION_LIFETIME_MS = 30 * 60 * 1000
const MAX_ADMISSION_AGE_MS = 5 * 60 * 1000
const MAX_DESTRUCTION_AGE_MS = 10 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 60 * 1000
const MAX_DESTRUCTION_AFTER_EXPIRY_MS = 30 * 60 * 1000

export function validatePreliminaryJitAdmission(value, bindings) {
  validateBindings(bindings)
  exactKeys(
    value,
    [
      "admitted_at",
      "composable",
      "evidence_class",
      "expires_at",
      "github",
      "promotable",
      "provenance",
      "repository",
      "runner",
      "schema",
      "source_sha",
      "vm",
      "workflow",
    ],
    "preliminary JIT admission",
  )
  requireValue(value.schema === "bharatcode-preliminary-jit-admission-v1", "preliminary JIT admission schema")
  validateClassification(value, "preliminary JIT admission")
  validateIdentity(value, bindings, "preliminary JIT admission")
  validateProvenance(
    value.provenance,
    bindings,
    bindings.admission_observation_id,
    bindings.admission_observed_at,
    "preliminary JIT admission provenance",
  )

  exactKeys(
    value.runner,
    [
      "ephemeral",
      "jit",
      "labels",
      "no_other_workload",
      "one_run",
      "registered_at",
      "runner_id",
      "runner_name_sha256",
      "scope",
    ],
    "preliminary JIT runner",
  )
  requirePattern(value.runner.runner_id, POSITIVE_DECIMAL, "preliminary JIT runner ID")
  requirePattern(value.runner.runner_name_sha256, SHA256, "preliminary JIT runner name digest")
  requireValue(value.runner.runner_id === bindings.runner_id, "preliminary JIT runner ID binding")
  requireValue(value.runner.runner_name_sha256 === bindings.runner_name_sha256, "preliminary JIT runner name binding")
  requireValue(value.runner.scope === "repository", "preliminary JIT runner scope")
  requireValue(
    Array.isArray(value.runner.labels) &&
      value.runner.labels.length === bindings.required_labels.length &&
      value.runner.labels.every((label, index) => label === bindings.required_labels[index]) &&
      new Set(value.runner.labels).size === value.runner.labels.length,
    "preliminary JIT runner labels",
  )
  for (const field of ["jit", "ephemeral", "one_run", "no_other_workload"]) {
    requireValue(value.runner[field] === true, `preliminary JIT runner ${field}`)
  }
  exactKeys(value.vm, ["dedicated", "image_sha256", "instance_id_sha256"], "preliminary JIT VM")
  requirePattern(value.vm.instance_id_sha256, SHA256, "preliminary JIT VM identity")
  requirePattern(value.vm.image_sha256, SHA256, "preliminary JIT VM image")
  requireValue(value.vm.instance_id_sha256 === bindings.vm_instance_id_sha256, "preliminary JIT VM identity binding")
  requireValue(value.vm.image_sha256 === bindings.vm_image_sha256, "preliminary JIT VM image binding")
  requireValue(value.vm.dedicated === true, "preliminary JIT VM dedication")

  const registeredAt = canonicalTime(value.runner.registered_at, "preliminary JIT registration time")
  const admittedAt = canonicalTime(value.admitted_at, "preliminary JIT admission time")
  const expiresAt = canonicalTime(value.expires_at, "preliminary JIT expiry time")
  const observedAt = canonicalTime(bindings.admission_observed_at, "expected preliminary JIT admission observation")
  requireValue(registeredAt <= admittedAt && admittedAt < expiresAt, "preliminary JIT admission chronology")
  requireValue(expiresAt - admittedAt <= MAX_ADMISSION_LIFETIME_MS, "preliminary JIT admission lifetime")
  requireValue(
    registeredAt >= observedAt - MAX_ADMISSION_AGE_MS &&
      admittedAt >= observedAt - MAX_ADMISSION_AGE_MS &&
      registeredAt <= observedAt + MAX_FUTURE_SKEW_MS &&
      admittedAt <= observedAt + MAX_FUTURE_SKEW_MS &&
      expiresAt >= observedAt,
    "preliminary JIT admission freshness",
  )
  return value
}

export function canonicalPreliminaryJitAdmissionJson(value, bindings) {
  const validated = validatePreliminaryJitAdmission(value, bindings)
  return `${JSON.stringify(projectAdmission(validated))}\n`
}

export function parsePreliminaryJitAdmissionJson(raw, bindings) {
  return validatePreliminaryJitAdmission(parseClosedJson(raw, "preliminary JIT admission"), bindings)
}

export function validatePreliminaryJitDestruction(value, admission, bindings) {
  validateDestructionBindings(bindings)
  const protectedAdmissionBindings = projectAdmissionBindings(bindings)
  validatePreliminaryJitAdmission(admission, protectedAdmissionBindings)
  exactKeys(
    value,
    [
      "admission_sha256",
      "completed_at",
      "composable",
      "evidence_class",
      "github",
      "promotable",
      "provenance",
      "repository",
      "runner",
      "schema",
      "source_sha",
      "vm",
      "workflow",
    ],
    "preliminary JIT destruction",
  )
  requireValue(value.schema === "bharatcode-preliminary-jit-destruction-v1", "preliminary JIT destruction schema")
  validateClassification(value, "preliminary JIT destruction")
  validateIdentity(value, bindings, "preliminary JIT destruction")
  validateProvenance(
    value.provenance,
    bindings,
    bindings.destruction_observation_id,
    bindings.destruction_observed_at,
    "preliminary JIT destruction provenance",
  )
  requireValue(
    value.provenance.provider === admission.provenance.provider &&
      value.provenance.controller_identity === admission.provenance.controller_identity &&
      value.provenance.observation_id !== admission.provenance.observation_id,
    "preliminary JIT destruction provenance binding",
  )
  requireValue(
    value.admission_sha256 === sha256(canonicalPreliminaryJitAdmissionJson(admission, protectedAdmissionBindings)),
    "preliminary JIT admission digest binding",
  )

  exactKeys(value.runner, ["deregistered", "deregistered_at", "runner_id"], "preliminary JIT destruction runner")
  requireValue(
    value.runner.runner_id === admission.runner.runner_id && value.runner.deregistered === true,
    "preliminary JIT runner deregistration",
  )
  exactKeys(value.vm, ["destroyed", "destroyed_at", "instance_id_sha256"], "preliminary JIT destruction VM")
  requireValue(
    value.vm.instance_id_sha256 === admission.vm.instance_id_sha256 && value.vm.destroyed === true,
    "preliminary JIT VM destruction",
  )
  const admittedAt = canonicalTime(admission.admitted_at, "preliminary JIT admission time")
  const deregisteredAt = canonicalTime(value.runner.deregistered_at, "preliminary JIT deregistration time")
  const destroyedAt = canonicalTime(value.vm.destroyed_at, "preliminary JIT destruction time")
  const completedAt = canonicalTime(value.completed_at, "preliminary JIT completion time")
  const expiresAt = canonicalTime(admission.expires_at, "preliminary JIT expiry time")
  const admissionObservedAt = canonicalTime(
    bindings.admission_observed_at,
    "expected preliminary JIT admission observation",
  )
  const destructionObservedAt = canonicalTime(
    bindings.destruction_observed_at,
    "expected preliminary JIT destruction observation",
  )
  requireValue(
    deregisteredAt > admittedAt &&
      destroyedAt > admittedAt &&
      deregisteredAt <= destroyedAt &&
      completedAt >= deregisteredAt &&
      completedAt >= destroyedAt,
    "preliminary JIT destruction chronology",
  )
  requireValue(destructionObservedAt >= admissionObservedAt, "preliminary JIT observation chronology")
  requireValue(
    deregisteredAt >= destructionObservedAt - MAX_DESTRUCTION_AGE_MS &&
      destroyedAt >= destructionObservedAt - MAX_DESTRUCTION_AGE_MS &&
      completedAt >= destructionObservedAt - MAX_DESTRUCTION_AGE_MS &&
      deregisteredAt <= destructionObservedAt + MAX_FUTURE_SKEW_MS &&
      destroyedAt <= destructionObservedAt + MAX_FUTURE_SKEW_MS &&
      completedAt <= destructionObservedAt + MAX_FUTURE_SKEW_MS &&
      completedAt <= expiresAt + MAX_DESTRUCTION_AFTER_EXPIRY_MS,
    "preliminary JIT destruction freshness",
  )
  return value
}

export function canonicalPreliminaryJitDestructionJson(value, admission, bindings) {
  const validated = validatePreliminaryJitDestruction(value, admission, bindings)
  return `${JSON.stringify(projectDestruction(validated))}\n`
}

export function parsePreliminaryJitDestructionJson(raw, admission, bindings) {
  return validatePreliminaryJitDestruction(parseClosedJson(raw, "preliminary JIT destruction"), admission, bindings)
}

function validateBindings(bindings) {
  exactKeys(
    bindings,
    [
      "admission_observed_at",
      "admission_observation_id",
      "controller_identity",
      "provider",
      "required_labels",
      "run_attempt",
      "run_id",
      "runner_id",
      "runner_name_sha256",
      "source_sha",
      "vm_image_sha256",
      "vm_instance_id_sha256",
    ],
    "preliminary JIT bindings",
  )
  requirePattern(bindings.source_sha, SOURCE_SHA, "expected preliminary JIT source")
  requirePattern(bindings.run_id, POSITIVE_DECIMAL, "expected preliminary JIT run ID")
  requirePattern(bindings.run_attempt, POSITIVE_DECIMAL, "expected preliminary JIT run attempt")
  requirePattern(bindings.provider, PROVIDER, "expected preliminary JIT provider")
  requirePattern(bindings.controller_identity, IDENTITY, "expected preliminary JIT controller identity")
  requirePattern(bindings.admission_observation_id, IDENTITY, "expected preliminary JIT admission observation ID")
  requirePattern(bindings.runner_id, POSITIVE_DECIMAL, "expected preliminary JIT runner ID")
  requirePattern(bindings.runner_name_sha256, SHA256, "expected preliminary JIT runner name digest")
  requirePattern(bindings.vm_instance_id_sha256, SHA256, "expected preliminary JIT VM identity")
  requirePattern(bindings.vm_image_sha256, SHA256, "expected preliminary JIT VM image")
  canonicalTime(bindings.admission_observed_at, "expected preliminary JIT admission observation")
  const expected = [
    "self-hosted",
    "windows",
    "x64",
    "wsl2",
    `bharatcode-acceptance-${bindings.run_id}-${bindings.run_attempt}`,
  ]
  requireValue(
    Array.isArray(bindings.required_labels) &&
      bindings.required_labels.length === expected.length &&
      bindings.required_labels.every((label, index) => label === expected[index]),
    "expected preliminary JIT labels",
  )
}

function validateDestructionBindings(bindings) {
  exactKeys(
    bindings,
    [...Object.keys(projectAdmissionBindings(bindings)), "destruction_observation_id", "destruction_observed_at"],
    "preliminary JIT destruction bindings",
  )
  validateBindings(projectAdmissionBindings(bindings))
  requirePattern(bindings.destruction_observation_id, IDENTITY, "expected preliminary JIT destruction observation ID")
  requireValue(
    bindings.admission_observation_id !== bindings.destruction_observation_id,
    "expected preliminary JIT observation IDs must be distinct",
  )
  canonicalTime(bindings.destruction_observed_at, "expected preliminary JIT destruction observation")
}

function projectAdmissionBindings(bindings) {
  return {
    source_sha: bindings.source_sha,
    run_id: bindings.run_id,
    run_attempt: bindings.run_attempt,
    required_labels: bindings.required_labels,
    provider: bindings.provider,
    controller_identity: bindings.controller_identity,
    admission_observation_id: bindings.admission_observation_id,
    runner_id: bindings.runner_id,
    runner_name_sha256: bindings.runner_name_sha256,
    vm_instance_id_sha256: bindings.vm_instance_id_sha256,
    vm_image_sha256: bindings.vm_image_sha256,
    admission_observed_at: bindings.admission_observed_at,
  }
}

function validateClassification(value, label) {
  requireValue(value.evidence_class === CLASSIFICATION, `${label} classification`)
  requireValue(value.promotable === false, `${label} promotion boundary`)
  requireValue(value.composable === false, `${label} composition boundary`)
}

function validateIdentity(value, bindings, label) {
  requireValue(value.repository === REPOSITORY, `${label} repository`)
  requireValue(value.workflow === WORKFLOW, `${label} workflow`)
  requireValue(value.source_sha === bindings.source_sha, `${label} source`)
  exactKeys(value.github, ["run_attempt", "run_id"], `${label} GitHub identity`)
  requireValue(value.github.run_id === bindings.run_id, `${label} run ID`)
  requireValue(value.github.run_attempt === bindings.run_attempt, `${label} run attempt`)
}

function validateProvenance(value, bindings, expectedObservationId, expectedObservedAt, label) {
  exactKeys(
    value,
    ["authority", "controller_identity", "guest_originated", "observation_id", "observed_at", "provider"],
    label,
  )
  requireValue(value.authority === "INDEPENDENT_HOST_CONTROL_PLANE", `${label} authority`)
  requireValue(value.guest_originated === false, `${label} guest boundary`)
  requirePattern(value.provider, PROVIDER, `${label} provider`)
  requirePattern(value.controller_identity, IDENTITY, `${label} controller identity`)
  requirePattern(value.observation_id, IDENTITY, `${label} observation ID`)
  canonicalTime(value.observed_at, `${label} observed time`)
  requireValue(value.provider === bindings.provider, `${label} provider binding`)
  requireValue(value.controller_identity === bindings.controller_identity, `${label} controller binding`)
  requireValue(value.observation_id === expectedObservationId, `${label} observation binding`)
  requireValue(value.observed_at === expectedObservedAt, `${label} observed time binding`)
}

function projectAdmission(value) {
  return {
    schema: value.schema,
    evidence_class: value.evidence_class,
    promotable: value.promotable,
    composable: value.composable,
    repository: value.repository,
    workflow: value.workflow,
    source_sha: value.source_sha,
    github: { run_id: value.github.run_id, run_attempt: value.github.run_attempt },
    provenance: {
      authority: value.provenance.authority,
      guest_originated: value.provenance.guest_originated,
      provider: value.provenance.provider,
      controller_identity: value.provenance.controller_identity,
      observation_id: value.provenance.observation_id,
      observed_at: value.provenance.observed_at,
    },
    runner: {
      runner_id: value.runner.runner_id,
      runner_name_sha256: value.runner.runner_name_sha256,
      scope: value.runner.scope,
      labels: [...value.runner.labels],
      jit: value.runner.jit,
      ephemeral: value.runner.ephemeral,
      one_run: value.runner.one_run,
      no_other_workload: value.runner.no_other_workload,
      registered_at: value.runner.registered_at,
    },
    vm: {
      instance_id_sha256: value.vm.instance_id_sha256,
      image_sha256: value.vm.image_sha256,
      dedicated: value.vm.dedicated,
    },
    admitted_at: value.admitted_at,
    expires_at: value.expires_at,
  }
}

function projectDestruction(value) {
  return {
    schema: value.schema,
    evidence_class: value.evidence_class,
    promotable: value.promotable,
    composable: value.composable,
    repository: value.repository,
    workflow: value.workflow,
    source_sha: value.source_sha,
    github: { run_id: value.github.run_id, run_attempt: value.github.run_attempt },
    admission_sha256: value.admission_sha256,
    provenance: {
      authority: value.provenance.authority,
      guest_originated: value.provenance.guest_originated,
      provider: value.provenance.provider,
      controller_identity: value.provenance.controller_identity,
      observation_id: value.provenance.observation_id,
      observed_at: value.provenance.observed_at,
    },
    runner: {
      runner_id: value.runner.runner_id,
      deregistered: value.runner.deregistered,
      deregistered_at: value.runner.deregistered_at,
    },
    vm: {
      instance_id_sha256: value.vm.instance_id_sha256,
      destroyed: value.vm.destroyed,
      destroyed_at: value.vm.destroyed_at,
    },
    completed_at: value.completed_at,
  }
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

function canonicalTime(value, label) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value), label)
  const parsed = Date.parse(value)
  requireValue(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, label)
  return parsed
}

function sha256(value) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function requirePattern(value, pattern, label) {
  requireValue(typeof value === "string" && pattern.test(value), label)
}

function exactKeys(value, keys, label) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`)
  requireValue(Object.keys(value).sort().join("\n") === [...keys].sort().join("\n"), `${label} keys are invalid`)
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
