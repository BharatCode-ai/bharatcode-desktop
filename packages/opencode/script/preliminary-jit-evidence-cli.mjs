import { canonicalLeanJson, parseLeanCohortBytes } from "./lean-cohort.mjs"
import {
  canonicalPreliminaryJitAdmissionJson,
  canonicalPreliminaryJitDestructionJson,
} from "./lean-preliminary-jit-lifecycle.mjs"
import {
  canonicalPreliminaryUnsignedWslJson,
  parsePreliminaryUnsignedWslJson,
} from "./lean-preliminary-unsigned-wsl.mjs"

const mode = process.argv[2]
if (!["admission", "cohort", "destruction", "receipt"].includes(mode) || process.argv.length !== 3) {
  throw new Error("preliminary JIT evidence operation is invalid")
}
const input = JSON.parse(await Bun.stdin.text())
const receipt = mode === "receipt" ? JSON.parse(input.raw) : undefined
const receiptBindings = receipt
  ? {
      adapter_sha256: receipt.controller_inputs.adapter_sha256,
      evidence_script_sha256: receipt.controller_inputs.evidence_script_sha256,
      source_sha: input.identity.source_sha,
      run_id: input.identity.run_id,
      run_attempt: input.identity.run_attempt,
      unsigned_installer_bytes: receipt.unsigned_installer.bytes,
      unsigned_installer_sha256: receipt.unsigned_installer.sha256,
      installed_desktop_bytes: receipt.installed_desktop.bytes,
      installed_desktop_sha256: receipt.installed_desktop.sha256,
      runtime_manifest_sha256: receipt.runtime_manifest_sha256,
      runtime_sha256: receipt.runtime.manifest_sha256,
      harness_sha256: receipt.harness.contract_sha256,
      validator_sha256: receipt.controller_inputs.validator_sha256,
    }
  : undefined
let output
if (mode === "admission") {
  output = canonicalPreliminaryJitAdmissionJson(input.record, input.bindings)
} else if (mode === "destruction") {
  output = canonicalPreliminaryJitDestructionJson(input.record, input.admission, input.bindings)
} else if (mode === "receipt") {
  output = canonicalPreliminaryUnsignedWslJson(
    parsePreliminaryUnsignedWslJson(input.raw, receiptBindings),
    receiptBindings,
  )
} else {
  if (typeof input.raw !== "string") throw new Error("signed cohort bytes are invalid")
  const value = parseLeanCohortBytes(new TextEncoder().encode(input.raw), input.identity)
  output = canonicalLeanJson(value)
}
process.stdout.write(output)
