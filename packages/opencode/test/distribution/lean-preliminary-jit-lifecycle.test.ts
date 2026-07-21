import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const contractPath = resolve(import.meta.dir, "../../script/lean-preliminary-jit-lifecycle.mjs")
const sourceSha = "7".repeat(40)
const runId = "29730000001"
const runAttempt = "2"
const labels = ["self-hosted", "windows", "x64", "wsl2", `bharatcode-acceptance-${runId}-${runAttempt}`]
const bindings = {
  source_sha: sourceSha,
  run_id: runId,
  run_attempt: runAttempt,
  required_labels: labels,
  provider: "bharatcode-jit-controller",
  controller_identity: "controller/release-wsl-v1",
  admission_observation_id: "admission-29730000001-2-0001",
  runner_id: "9812345",
  runner_name_sha256: "a".repeat(64),
  vm_instance_id_sha256: "b".repeat(64),
  vm_image_sha256: "c".repeat(64),
  admission_observed_at: "2026-07-20T10:00:02.000Z",
}
const destructionBindings = {
  ...bindings,
  destruction_observation_id: "destruction-29730000001-2-0001",
  destruction_observed_at: "2026-07-20T10:42:02.000Z",
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)]),
  )
}

function admission() {
  return {
    schema: "bharatcode-preliminary-jit-admission-v1",
    evidence_class: "PRELIMINARY_UNSIGNED",
    promotable: false,
    composable: false,
    repository: "BharatCode-ai/bharatcode-desktop",
    workflow: ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
    source_sha: sourceSha,
    github: { run_id: runId, run_attempt: runAttempt },
    provenance: {
      authority: "INDEPENDENT_HOST_CONTROL_PLANE",
      guest_originated: false,
      provider: "bharatcode-jit-controller",
      controller_identity: "controller/release-wsl-v1",
      observation_id: "admission-29730000001-2-0001",
      observed_at: "2026-07-20T10:00:02.000Z",
    },
    runner: {
      runner_id: "9812345",
      runner_name_sha256: "a".repeat(64),
      scope: "repository",
      labels,
      jit: true,
      ephemeral: true,
      one_run: true,
      no_other_workload: true,
      registered_at: "2026-07-20T10:00:00.000Z",
    },
    vm: {
      instance_id_sha256: "b".repeat(64),
      image_sha256: "c".repeat(64),
      dedicated: true,
    },
    admitted_at: "2026-07-20T10:00:01.000Z",
    expires_at: "2026-07-20T10:30:01.000Z",
  }
}

function destruction(admissionSha256: string) {
  return {
    schema: "bharatcode-preliminary-jit-destruction-v1",
    evidence_class: "PRELIMINARY_UNSIGNED",
    promotable: false,
    composable: false,
    repository: "BharatCode-ai/bharatcode-desktop",
    workflow: ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
    source_sha: sourceSha,
    github: { run_id: runId, run_attempt: runAttempt },
    admission_sha256: admissionSha256,
    provenance: {
      authority: "INDEPENDENT_HOST_CONTROL_PLANE",
      guest_originated: false,
      provider: "bharatcode-jit-controller",
      controller_identity: "controller/release-wsl-v1",
      observation_id: "destruction-29730000001-2-0001",
      observed_at: "2026-07-20T10:42:02.000Z",
    },
    runner: { runner_id: "9812345", deregistered: true, deregistered_at: "2026-07-20T10:41:00.000Z" },
    vm: { instance_id_sha256: "b".repeat(64), destroyed: true, destroyed_at: "2026-07-20T10:42:00.000Z" },
    completed_at: "2026-07-20T10:42:01.000Z",
  }
}

async function contract() {
  expect(await Bun.file(contractPath).exists()).toBeTrue()
  return import(pathToFileURL(contractPath).href)
}

describe("preliminary one-run JIT lifecycle contract", () => {
  test("accepts only one closed independent host admission and destruction chain", async () => {
    const api = await contract()
    const accepted = admission()
    const admissionBytes = api.canonicalPreliminaryJitAdmissionJson(accepted, bindings)
    const completed = destruction(new Bun.CryptoHasher("sha256").update(admissionBytes).digest("hex"))
    expect(api.validatePreliminaryJitAdmission(accepted, bindings)).toEqual(accepted)
    expect(admissionBytes).toBe(`${JSON.stringify(accepted)}\n`)
    expect(api.validatePreliminaryJitDestruction(completed, accepted, destructionBindings)).toEqual(completed)
    expect(api.canonicalPreliminaryJitDestructionJson(completed, accepted, destructionBindings)).toBe(
      `${JSON.stringify(completed)}\n`,
    )
  })

  test("rejects mutable, guest-originated, reusable, foreign, and malformed admission", async () => {
    const api = await contract()
    const value = admission()
    for (const hostile of [
      { ...value, extra: true },
      { ...value, evidence_class: "PASS" },
      { ...value, promotable: true },
      { ...value, composable: true },
      { ...value, source_sha: "8".repeat(40) },
      { ...value, github: { ...value.github, run_attempt: "3" } },
      { ...value, provenance: { ...value.provenance, guest_originated: true } },
      { ...value, provenance: { ...value.provenance, authority: "GUEST" } },
      { ...value, runner: { ...value.runner, labels: [...labels.slice(0, 4), "bharatcode-acceptance"] } },
      { ...value, runner: { ...value.runner, jit: false } },
      { ...value, runner: { ...value.runner, ephemeral: false } },
      { ...value, runner: { ...value.runner, one_run: false } },
      { ...value, runner: { ...value.runner, no_other_workload: false } },
      { ...value, runner: { ...value.runner, scope: "organization" } },
      { ...value, runner: { ...value.runner, runner_id: "01" } },
      { ...value, vm: { ...value.vm, dedicated: false } },
      { ...value, admitted_at: "2026-07-20T09:59:59.000Z" },
      { ...value, expires_at: value.admitted_at },
      { ...value, expires_at: "2026-07-20T10:30:01Z" },
    ]) {
      expect(() => api.validatePreliminaryJitAdmission(hostile, bindings)).toThrow()
    }
  })

  test("rejects substituted, incomplete, reordered, or guest-authored destruction", async () => {
    const api = await contract()
    const accepted = admission()
    const admissionSha256 = new Bun.CryptoHasher("sha256")
      .update(api.canonicalPreliminaryJitAdmissionJson(accepted, bindings))
      .digest("hex")
    const value = destruction(admissionSha256)
    for (const hostile of [
      { ...value, extra: true },
      { ...value, admission_sha256: "0".repeat(64) },
      { ...value, github: { ...value.github, run_id: "29730000002" } },
      { ...value, provenance: { ...value.provenance, guest_originated: true } },
      { ...value, provenance: { ...value.provenance, observation_id: accepted.provenance.observation_id } },
      { ...value, provenance: { ...value.provenance, observed_at: "2026-07-20T10:42:01.000Z" } },
      { ...value, provenance: { ...value.provenance, controller_identity: "controller/foreign" } },
      { ...value, runner: { ...value.runner, runner_id: "9812346" } },
      { ...value, runner: { ...value.runner, deregistered: false } },
      { ...value, runner: { ...value.runner, deregistered_at: accepted.admitted_at } },
      { ...value, vm: { ...value.vm, instance_id_sha256: "d".repeat(64) } },
      { ...value, vm: { ...value.vm, destroyed: false } },
      { ...value, vm: { ...value.vm, destroyed_at: accepted.admitted_at } },
      { ...value, completed_at: "2026-07-20T10:41:59.000Z" },
      { ...value, completed_at: "2026-07-20T10:42:01Z" },
    ]) {
      expect(() => api.validatePreliminaryJitDestruction(hostile, accepted, destructionBindings)).toThrow()
    }
  })

  test("binds host-protected provenance, runner, VM, and trusted chronology", async () => {
    const api = await contract()
    const accepted = admission()
    for (const hostile of [
      { ...accepted, provenance: { ...accepted.provenance, provider: "evil-controller" } },
      { ...accepted, provenance: { ...accepted.provenance, controller_identity: "foreign/controller" } },
      { ...accepted, provenance: { ...accepted.provenance, observation_id: "admission-replay-0002" } },
      { ...accepted, provenance: { ...accepted.provenance, observed_at: "2026-07-20T09:59:00.000Z" } },
      { ...accepted, runner: { ...accepted.runner, runner_id: "7777777" } },
      { ...accepted, runner: { ...accepted.runner, runner_name_sha256: "d".repeat(64) } },
      { ...accepted, vm: { ...accepted.vm, instance_id_sha256: "d".repeat(64) } },
      { ...accepted, vm: { ...accepted.vm, image_sha256: "d".repeat(64) } },
      {
        ...accepted,
        runner: { ...accepted.runner, registered_at: "2020-01-01T00:00:00.000Z" },
        admitted_at: "2020-01-01T00:00:01.000Z",
        expires_at: "9999-01-01T00:00:00.000Z",
      },
      { ...accepted, expires_at: "2026-07-20T11:30:01.000Z" },
      {
        ...accepted,
        runner: { ...accepted.runner, registered_at: "2026-07-20T09:49:59.000Z" },
        admitted_at: "2026-07-20T09:50:00.000Z",
        expires_at: "2026-07-20T10:20:00.000Z",
      },
      {
        ...accepted,
        runner: { ...accepted.runner, registered_at: "2099-01-01T00:00:00.000Z" },
        admitted_at: "2099-01-01T00:00:01.000Z",
        expires_at: "2099-01-01T00:30:01.000Z",
      },
    ]) {
      expect(() => api.validatePreliminaryJitAdmission(hostile, bindings)).toThrow()
    }

    const admissionBytes = api.canonicalPreliminaryJitAdmissionJson(accepted, bindings)
    const completed = destruction(new Bun.CryptoHasher("sha256").update(admissionBytes).digest("hex"))
    for (const hostile of [
      {
        ...completed,
        runner: { ...completed.runner, deregistered_at: "2026-07-20T10:31:00.000Z" },
        vm: { ...completed.vm, destroyed_at: "2026-07-20T10:31:01.000Z" },
        completed_at: "2026-07-20T10:31:02.000Z",
      },
      {
        ...completed,
        runner: { ...completed.runner, deregistered_at: "2026-07-20T11:00:00.000Z" },
        vm: { ...completed.vm, destroyed_at: "2026-07-20T11:00:01.000Z" },
        completed_at: "2026-07-20T11:00:02.000Z",
      },
      {
        ...completed,
        runner: { ...completed.runner, deregistered_at: "2026-07-20T10:43:03.000Z" },
        vm: { ...completed.vm, destroyed_at: "2026-07-20T10:43:04.000Z" },
        completed_at: "2026-07-20T10:43:05.000Z",
      },
      {
        ...completed,
        runner: { ...completed.runner, deregistered_at: "2026-07-20T10:42:00.000Z" },
        vm: { ...completed.vm, destroyed_at: "2026-07-20T10:41:59.000Z" },
      },
    ]) {
      expect(() => api.validatePreliminaryJitDestruction(hostile, accepted, destructionBindings)).toThrow()
    }
  })

  test("canonicalizes JIT records independently of insertion order and rejects duplicate raw keys", async () => {
    const api = await contract()
    const accepted = admission()
    const admissionBytes = api.canonicalPreliminaryJitAdmissionJson(accepted, bindings)
    const permutedAdmissionBytes = api.canonicalPreliminaryJitAdmissionJson(reverseKeys(accepted), bindings)
    expect(permutedAdmissionBytes).toBe(admissionBytes)
    expect(new Bun.CryptoHasher("sha256").update(permutedAdmissionBytes).digest("hex")).toBe(
      new Bun.CryptoHasher("sha256").update(admissionBytes).digest("hex"),
    )
    const completed = destruction(new Bun.CryptoHasher("sha256").update(admissionBytes).digest("hex"))
    const destructionBytes = api.canonicalPreliminaryJitDestructionJson(completed, accepted, destructionBindings)
    const permutedDestructionBytes = api.canonicalPreliminaryJitDestructionJson(
      reverseKeys(completed),
      reverseKeys(accepted),
      destructionBindings,
    )
    expect(permutedDestructionBytes).toBe(destructionBytes)
    expect(new Bun.CryptoHasher("sha256").update(permutedDestructionBytes).digest("hex")).toBe(
      new Bun.CryptoHasher("sha256").update(destructionBytes).digest("hex"),
    )
    const parseAdmission = Reflect.get(api, "parsePreliminaryJitAdmissionJson")
    const parseDestruction = Reflect.get(api, "parsePreliminaryJitDestructionJson")
    expect(parseAdmission).toBeFunction()
    expect(parseDestruction).toBeFunction()
    expect(() =>
      parseAdmission(
        admissionBytes.replace(
          '"schema":"bharatcode-preliminary-jit-admission-v1"',
          '"schema":"bharatcode-preliminary-jit-admission-v1","schema":"bharatcode-preliminary-jit-admission-v1"',
        ),
        bindings,
      ),
    ).toThrow(/duplicate/iu)
    expect(() =>
      parseDestruction(
        destructionBytes.replace(
          '"schema":"bharatcode-preliminary-jit-destruction-v1"',
          '"schema":"bharatcode-preliminary-jit-destruction-v1","schema":"bharatcode-preliminary-jit-destruction-v1"',
        ),
        accepted,
        destructionBindings,
      ),
    ).toThrow(/duplicate/iu)
    expect(() => parseAdmission(`${JSON.stringify({ ...accepted, extra: true })}\n`, bindings)).toThrow()
    expect(() =>
      parseDestruction(`${JSON.stringify({ ...completed, extra: true })}\n`, accepted, destructionBindings),
    ).toThrow()
  })
})
