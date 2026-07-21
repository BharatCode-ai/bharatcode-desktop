import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { validateLeanCohort, validateLeanWslReceipt } from "../../script/lean-cohort.mjs"
import {
  canonicalPreliminaryUnsignedWslJson,
  validatePreliminaryUnsignedWslReceipt,
} from "../../script/lean-preliminary-unsigned-wsl.mjs"

const root = resolve(import.meta.dir, "../../../..")
const workflowPath = resolve(root, ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml")
const finalWorkflowPath = resolve(root, ".github/workflows/bharatcode-next-beta-candidate.yml")
const namespaceHelperPath = resolve(root, "packages/desktop/scripts/wsl-windows-preliminary-controller.ps1")
const namespaceTestPath = resolve(root, "packages/desktop/scripts/wsl-windows-preliminary-controller.test.ps1")
const nsisFixturePath = resolve(root, "packages/desktop/test/fixtures/preliminary-unsigned-controller.nsi")
const jitContractPath = resolve(root, "packages/opencode/script/lean-preliminary-jit-lifecycle.mjs")
const jitControllerPath = resolve(root, "packages/desktop/scripts/preliminary-wsl-jit-host-controller.ps1")
const jitAdapterPath = resolve(root, "packages/opencode/script/preliminary-jit-evidence-cli.mjs")
const acceptedWslSha = "f223e2c6b53f567667491f6f1e5667c42fb73fa0"
const finalWorkflowSha256 = "79b4843c8249c820d0c58306aa2d39bddd0e8f52cc39ede627acf1ff9be9459f"
const label = "bharatcode-acceptance-${{ github.run_id }}-${{ github.run_attempt }}"
const checkout = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const upload = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const download = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
const frozenWslPaths = [
  "packages/desktop/electron-builder.config.ts",
  "packages/desktop/scripts/stage-wsl-runtime.ts",
  "packages/desktop/scripts/wsl-windows-acceptance.mjs",
  "packages/desktop/src/main/index.ts",
  "packages/desktop/src/main/ipc.ts",
  "packages/desktop/src/main/server.ts",
  "packages/desktop/src/main/windows.ts",
  "packages/desktop/src/main/wsl-*",
  "packages/desktop/src/preload/index.ts",
  "packages/desktop/src/preload/types.ts",
  "packages/desktop/src/renderer/index.tsx",
  "packages/opencode/script/build.ts",
  "packages/opencode/src/cli/cmd/serve.ts",
  "packages/opencode/src/server/wsl-desktop-transport.ts",
] as const

type Step = {
  if?: string
  name?: string
  run?: string
  uses?: string
  shell?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
}

type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } }
  permissions: Record<string, string>
  env: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string[] | string
      permissions?: Record<string, string>
      "runs-on"?: string | string[]
      steps?: Step[]
    }
  >
}

async function source() {
  expect(await Bun.file(workflowPath).exists()).toBeTrue()
  return Bun.file(workflowPath).text()
}

function parse(value: string) {
  return Bun.YAML.parse(value) as Workflow
}

function step(value: string, job: string, name: string) {
  const result = parse(value).jobs[job]?.steps?.find((item) => item.name === name)
  if (!result) throw new Error(`missing ${job}/${name}`)
  return result
}

function renderLabels(value: string, runId: string, runAttempt: string) {
  if (!/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error("test run identity is invalid")
  }
  const labels = parse(value).jobs["accept-preliminary-unsigned-wsl"]?.["runs-on"]
  if (!Array.isArray(labels)) throw new Error("preliminary runner labels are not closed")
  return labels.map((item) =>
    item.replaceAll("${{ github.run_id }}", runId).replaceAll("${{ github.run_attempt }}", runAttempt),
  )
}

const sha256 = (value: string | ArrayBuffer | Uint8Array) =>
  createHash("sha256")
    .update(value instanceof ArrayBuffer ? new Uint8Array(value) : value)
    .digest("hex")
const sourceSha = "9".repeat(40)
const bindings = {
  adapter_sha256: "2".repeat(64),
  evidence_script_sha256: "3".repeat(64),
  source_sha: sourceSha,
  run_id: "123456789",
  run_attempt: "2",
  unsigned_installer_bytes: 4096,
  unsigned_installer_sha256: "a".repeat(64),
  installed_desktop_bytes: 8192,
  installed_desktop_sha256: "b".repeat(64),
  runtime_manifest_sha256: "c".repeat(64),
  runtime_sha256: "e".repeat(64),
  validator_sha256: "4".repeat(64),
  harness_sha256: "d".repeat(64),
}

function receipt() {
  return {
    schema: "bharatcode-wsl-preliminary-unsigned-v1",
    evidence_class: "PRELIMINARY_UNSIGNED",
    result: "PRELIMINARY_UNSIGNED",
    signature_status: "PRELIMINARY_UNSIGNED",
    provenance_status: "PRELIMINARY_UNSIGNED",
    cleanup_complete: true,
    promotable: false,
    composable: false,
    controller_inputs: {
      adapter_sha256: "2".repeat(64),
      evidence_script_sha256: "3".repeat(64),
      validator_sha256: "4".repeat(64),
    },
    repository: "BharatCode-ai/bharatcode-desktop",
    workflow: ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
    source_sha: sourceSha,
    github: { run_id: 123456789, run_attempt: 2 },
    unsigned_installer: {
      filename: "bharatcode-desktop-preliminary-unsigned-test-win-x64.exe",
      bytes: 4096,
      sha256: "a".repeat(64),
    },
    installed_desktop: { filename: "BharatCode Beta.exe", bytes: 8192, sha256: "b".repeat(64) },
    runtime_manifest_sha256: "c".repeat(64),
    runtime: {
      manifest_source_sha: sourceSha,
      executed_source_sha: sourceSha,
      manifest_sha256: "e".repeat(64),
      executed_sha256: "e".repeat(64),
    },
    harness: {
      contract: "packages/desktop/scripts/wsl-windows-acceptance.mjs",
      contract_sha256: "d".repeat(64),
      authority: "DIAGNOSTIC",
    },
    identity: { distro_sha256: "f".repeat(64), user_sha256: "1".repeat(64), uid: 1000 },
    scenarios: { "9": true, "10": true },
    completed_at: "2026-07-20T00:00:00.000Z",
  }
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

function installedAcceptanceViolations(value: string) {
  const build = step(value, "package-preliminary-unsigned-windows", "Build and verify unsigned TEST-only NSIS")
  const buildRun = build.run ?? ""
  const uploadStep = step(
    value,
    "package-preliminary-unsigned-windows",
    "Upload same-run unsigned TEST-only package inputs",
  )
  const uploadPath = String(uploadStep.with?.path ?? "")
  const acceptance =
    step(value, "accept-preliminary-unsigned-wsl", "Run one handle-bound installed Desktop preliminary transaction")
      .run ?? ""
  return [
    ...(build.env?.BHARATCODE_ALLOW_UNSIGNED_WINDOWS === "1" ? [] : ["explicit unsigned build authority"]),
    ...(buildRun.includes("electron-builder --win nsis --x64") ? [] : ["NSIS build"]),
    ...(buildRun.includes('Status -ne "NotSigned"') &&
    buildRun.includes("SignerCertificate") &&
    buildRun.includes("TimeStamperCertificate")
      ? []
      : ["unsigned package proof"]),
    ...(uploadPath.includes("bharatcode-wsl-runtime-manifest.json") &&
    uploadPath.includes("bharatcode-runtime-linux-x64-glibc")
      ? []
      : ["adjacent raw runtime inputs"]),
    ...(acceptance.includes("Invoke-PreliminaryController") &&
    acceptance.includes("-Installer $installer") &&
    acceptance.includes("-ExpectedVersion")
      ? []
      : ["one controller-owned NSIS install"]),
    ...(acceptance.includes('"--desktop-exe", process.env.INSTALLED_DESKTOP_EXE') &&
    !acceptance.includes('"--desktop-exe", process.env.UNSIGNED_INSTALLER_PATH')
      ? []
      : ["installed Desktop harness entrypoint"]),
    ...(acceptance.includes("const manifest = process.env.PRELIMINARY_RUNTIME_MANIFEST") &&
    acceptance.includes("const runtime = process.env.PRELIMINARY_RUNTIME") &&
    acceptance.includes('-RuntimeManifestPath "preliminary-input/bharatcode-wsl-runtime-manifest.json"') &&
    acceptance.includes('-RuntimePath "preliminary-input/bharatcode-runtime-linux-x64-glibc"')
      ? []
      : ["raw runtime harness binding"]),
    ...(acceptance.includes("sha256: result.evidence.desktop_sha256") ? [] : ["harness Desktop digest binding"]),
    ...(acceptance.includes("const result = await runPreliminaryWindowsAcceptance(argv)") &&
    acceptance.includes('result.authority !== "PRELIMINARY_UNSIGNED"') &&
    acceptance.includes('result.harness_authority !== "DIAGNOSTIC"') &&
    acceptance.includes("authority: result.harness_authority") &&
    !acceptance.includes("harness_sha256: bindings.harness_sha256, authority: result.authority")
      ? []
      : ["preliminary-only harness authority"]),
    ...(acceptance.includes("cleanup_complete: true") ? [] : ["cleanup-bound receipt"]),
  ]
}

async function namespaceAuthorityViolations(value: string) {
  const helper = (await Bun.file(namespaceHelperPath).exists()) ? await Bun.file(namespaceHelperPath).text() : ""
  const tests = (await Bun.file(namespaceTestPath).exists()) ? await Bun.file(namespaceTestPath).text() : ""
  const windowsTests = step(
    value,
    "package-preliminary-unsigned-windows",
    "Run Windows namespace authority hostile tests",
  )
  const transaction = step(
    value,
    "accept-preliminary-unsigned-wsl",
    "Run one handle-bound installed Desktop preliminary transaction",
  )
  const absence = step(value, "accept-preliminary-unsigned-wsl", "Prove preliminary namespace absence")
  const transactionRun = transaction.run ?? ""
  const absenceRun = absence.run ?? ""
  return [
    ...(windowsTests.shell === "pwsh" &&
    windowsTests.run?.includes("wsl-windows-preliminary-controller.test.ps1") &&
    tests.includes("nonce collision") &&
    tests.includes("after-create") &&
    tests.includes("after-dacl") &&
    tests.includes("after-file-id") &&
    tests.includes("ancestor junction") &&
    tests.includes("leaf junction collision") &&
    tests.includes("dangling reparse") &&
    tests.includes("held root replacement") &&
    tests.includes("stale file ID") &&
    tests.includes("stale final path") &&
    tests.includes("DACL drift") &&
    tests.includes("prefix-lookalike foreign process") &&
    tests.includes("harness child/grandchild did not enter the job") &&
    tests.includes("pinned harness overwrite") &&
    tests.includes("pinned harness delete") &&
    tests.includes("junction target was traversed") &&
    tests.includes("malicious uninstaller was executed") &&
    tests.includes("controller crash did not leave the documented orphan") &&
    tests.includes("production controlled failure")
      ? []
      : ["executable Windows hostile suite"]),
    ...(helper.includes("NtCreateFile") &&
    helper.includes("FILE_CREATE") &&
    helper.includes("FILE_DIRECTORY_FILE") &&
    helper.includes("SafeFileHandle") &&
    helper.includes("RandomNumberGenerator") &&
    helper.includes("^[0-9a-f]{64}$") &&
    helper.includes("GetDriveTypeW") &&
    helper.includes("DRIVE_FIXED") &&
    helper.includes("GetFinalPathNameByHandleW") &&
    helper.includes("VolumeSerialNumber") &&
    helper.includes("FILE_ID_INFO") &&
    helper.includes("AreAccessRulesProtected") &&
    helper.includes("LocalSystemSid") &&
    helper.includes("CREATE_SUSPENDED") &&
    helper.includes("AssignProcessToJobObject") &&
    helper.includes("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE") &&
    helper.includes("JOB_OBJECT_BASIC_PROCESS_ID_LIST") &&
    helper.includes("JobProcessIds") &&
    helper.includes("ContentIdentity") &&
    helper.includes("GENERIC_READ") &&
    helper.includes("NtSetInformationFile") &&
    helper.includes("FILE_OPEN_REPARSE_POINT") &&
    !helper.includes(".bharatcode-preliminary-owner") &&
    !helper.includes("CREATE_BREAKAWAY_FROM_JOB") &&
    !helper.includes("JOB_OBJECT_LIMIT_BREAKAWAY_OK") &&
    !helper.includes("NamedPipe") &&
    !helper.match(/Start-Process[^\n]*[Uu]ninstall/u) &&
    !helper.match(/Remove-Item[^\n]*-Recurse/u)
      ? []
      : ["handle-bound unguessable authority"]),
    ...(transaction.shell === "pwsh" &&
    transactionRun.includes("wsl-windows-preliminary-controller.ps1") &&
    transactionRun.includes("Invoke-PreliminaryController") &&
    transactionRun.includes("runPreliminaryWindowsAcceptance(argv)") &&
    transactionRun.includes("canonicalPreliminaryUnsignedWslJson(receipt, bindings)") &&
    transactionRun.includes("cleanup_complete: true") &&
    transactionRun.includes('ReceiptPath "bharatcode-wsl-preliminary-unsigned.json"')
      ? []
      : ["one live authority transaction"]),
    ...(absence.if === "${{ always() }}" &&
    absence.shell === "pwsh" &&
    absenceRun.includes("Assert-PreliminaryNamespacePrefixAbsent") &&
    !absenceRun.includes("Remove-Item") &&
    !absenceRun.includes("Test-Path")
      ? []
      : ["non-authoritative always absence verifier"]),
    ...(["Install unsigned NSIS into an atomically reserved root", "Clean preliminary install namespace"].some((name) =>
      parse(value).jobs["accept-preliminary-unsigned-wsl"].steps?.some((item) => item.name === name),
    )
      ? ["legacy split authority steps"]
      : []),
  ]
}

async function controllerC1Violations(value: string) {
  const helper = (await Bun.file(namespaceHelperPath).exists()) ? await Bun.file(namespaceHelperPath).text() : ""
  const tests = (await Bun.file(namespaceTestPath).exists()) ? await Bun.file(namespaceTestPath).text() : ""
  const transaction =
    step(value, "accept-preliminary-unsigned-wsl", "Run one handle-bound installed Desktop preliminary transaction")
      .run ?? ""
  return [
    ...(helper.includes("AcquireRunnerTempHandleRelative") &&
    helper.includes("OpenRelative") &&
    helper.includes("FILE_OPEN_REPARSE_POINT") &&
    helper.includes("expectedParentFileId") &&
    !helper.includes("var parentPath = ValidateRunnerTemp(runnerTemp)")
      ? []
      : ["retained handle-relative RUNNER_TEMP acquisition"]),
    ...(helper.includes("Get-PreliminaryControllerTransactionPaths") &&
    helper.includes("$paths = Get-PreliminaryControllerTransactionPaths -Lease $lease") &&
    helper.includes("$scriptPath = $paths.EvidenceScript") &&
    helper.includes("$candidatePath = $paths.ReceiptCandidate") &&
    helper.includes("$env:PRELIMINARY_ACCEPTANCE_DIR = $paths.AcceptanceDirectory") &&
    !helper.includes('Join-Path $RunnerTemp ".$($lease.RootLeaf)-evidence.mjs"') &&
    !helper.includes('Join-Path $RunnerTemp ".$($lease.RootLeaf)-receipt-candidate.json"')
      ? []
      : ["lease-owned acceptance and evidence paths"]),
    ...(helper.includes("StringComparison.OrdinalIgnoreCase") &&
    tests.includes("retained runner temp rename") &&
    tests.includes("mixed-case prefix observation") &&
    tests.includes("owned acceptance state survived cleanup")
      ? []
      : ["case-insensitive executable cleanup coverage"]),
    ...(transaction.includes('"--acceptance-dir", process.env.PRELIMINARY_ACCEPTANCE_DIR') &&
    !transaction.includes("`${process.env.RUNNER_TEMP}\\bharatcode-wsl-preliminary-acceptance`")
      ? []
      : ["lease-owned harness acceptance directory"]),
  ]
}

async function controllerC2Violations(value: string) {
  const helper = (await Bun.file(namespaceHelperPath).exists()) ? await Bun.file(namespaceHelperPath).text() : ""
  const tests = (await Bun.file(namespaceTestPath).exists()) ? await Bun.file(namespaceTestPath).text() : ""
  const fixture = (await Bun.file(nsisFixturePath).exists()) ? await Bun.file(nsisFixturePath).text() : ""
  return [
    ...(helper.includes("BeginStage") &&
    helper.includes("CloseStage") &&
    helper.includes("AssertNoOwnedProcesses") &&
    helper.lastIndexOf('$lease.BeginStage("installer")') <
      helper.lastIndexOf('$lease.PinOwnedRelative("installed", "BharatCode Beta.exe")') &&
    helper.indexOf("$lease.CloseStage()", helper.lastIndexOf('$lease.BeginStage("installer")')) <
      helper.lastIndexOf('$lease.PinOwnedRelative("installed", "BharatCode Beta.exe")') &&
    helper.lastIndexOf('$lease.BeginStage("harness")') < helper.lastIndexOf('PinnedBytes("receipt-candidate")')
      ? []
      : ["separate installer/harness jobs with empty PID barriers"]),
    ...(helper.includes("Get-PreliminaryNsisArguments") &&
    helper.includes("$installArguments = Get-PreliminaryNsisArguments -InstallRoot $lease.RootPath") &&
    !helper.includes('/D=`"$($lease.RootPath)`"') &&
    fixture.includes('InstallDir "$TEMP\\bharatcode-preliminary-nsis-decoy"') &&
    fixture.includes('File /oname="BharatCode Beta.exe"') &&
    tests.includes("legacy quoted NSIS /D did not misplace the fixture") &&
    tests.includes("real NSIS fixture escaped the lease root")
      ? []
      : ["exact final unquoted NSIS /D with real fixture"]),
    ...(helper.includes("PinExternal") &&
    helper.includes("PinOwned") &&
    helper.includes('$pinnedFiles.PinExternal("installer", $installerPath)') &&
    helper.indexOf('$pinnedFiles.PinExternal("installer", $installerPath)') <
      helper.indexOf("Get-AuthenticodeSignature $installerPath") &&
    helper.includes('WriteNew("evidence-script"') &&
    ["adapter", "validator", "frozen-harness", "runtime-manifest", "runtime"].every((label) =>
      helper.includes(`Copy-PreliminaryPinnedInput -Lease $lease -Label "${label}"`),
    ) &&
    helper.includes('$pinnedFiles.PinExternal("bun", $bunPath)') &&
    tests.includes("external pin replacement") &&
    tests.includes("owned pin replacement")
      ? []
      : ["full-lifetime external and owned file pins"]),
    ...(helper.includes("forceAssignmentFailure") &&
    helper.includes("LastAssignmentFailureProcessId") &&
    helper.includes("TerminateProcess") &&
    helper.includes("WaitForSingleObject") &&
    tests.includes("assignment failure process survived checked termination")
      ? []
      : ["checked assignment-failure termination and wait"]),
  ]
}

async function controllerC3Violations(value: string) {
  const helper = (await Bun.file(namespaceHelperPath).exists()) ? await Bun.file(namespaceHelperPath).text() : ""
  const tests = (await Bun.file(namespaceTestPath).exists()) ? await Bun.file(namespaceTestPath).text() : ""
  const boundaries = [
    "after-create",
    "after-dacl",
    "after-file-id",
    "after-reservation",
    "after-installer-pin",
    "after-installer-launch",
    "after-installer-exit",
    "after-installer-stage",
    "after-installed-pin",
    "after-acceptance-directory",
    "after-contracts-directory",
    "after-inputs-directory",
    "after-adapter-copy",
    "after-adapter-pin",
    "after-validator-copy",
    "after-validator-pin",
    "after-frozen-harness-copy",
    "after-frozen-harness-pin",
    "after-runtime-manifest-copy",
    "after-runtime-manifest-pin",
    "after-runtime-copy",
    "after-runtime-pin",
    "after-evidence-write",
    "after-evidence-pin",
    "after-environment-binding",
    "after-harness-pin",
    "after-harness-launch",
    "after-harness-exit",
    "after-harness-stage",
    "after-receipt-pin",
    "after-receipt-read",
    "after-cleanup-before-publication",
  ]
  return [
    ...(!helper.includes("Invoke-PreliminaryControllerTestScenario") &&
    !helper.includes("CrashProbe") &&
    helper.includes("Assert-PreliminaryControllerTestHooks") &&
    helper.includes("Invoke-PreliminaryControllerBoundary") &&
    boundaries.every((boundary) => helper.includes(`\"${boundary}\"`))
      ? []
      : ["closed production-controller failpoint boundaries"]),
    ...(value.includes("TestHooks") ? ["workflow test-hook authority"] : []),
    ...(tests.includes("Invoke-PreliminaryController @invoke") &&
    tests.includes("production controlled failure") &&
    tests.includes("production failure deleted foreign lookalike") &&
    tests.includes("production failure published a receipt") &&
    tests.includes("production controller assignment failure") &&
    tests.includes("production installer assignment failure") &&
    tests.includes("production candidate substitution") &&
    tests.includes("production evidence collision") &&
    tests.includes("production final receipt collision") &&
    tests.includes("production immutable input substitution") &&
    tests.includes("closed production controller test hooks") &&
    tests.includes("production controller test authority") &&
    tests.includes("production failure leaked transaction environment") &&
    tests.includes("terminated production controller published a receipt") &&
    tests.includes("external JIT host controller remains required")
      ? []
      : ["executable production-controller hostile matrix"]),
  ]
}

async function controllerC4BViolations() {
  const helper = (await Bun.file(namespaceHelperPath).exists()) ? await Bun.file(namespaceHelperPath).text() : ""
  const tests = (await Bun.file(namespaceTestPath).exists()) ? await Bun.file(namespaceTestPath).text() : ""
  const invoke = helper.slice(helper.indexOf("function Invoke-PreliminaryController {"))
  return [
    ...(helper.includes("DirectoryChainAuthority") &&
    helper.includes("OwnedDirectoryAuthority") &&
    helper.includes("PinnedFileAuthority") &&
    helper.includes("PublicationAuthority") &&
    helper.includes("AcquireDirectoryChain") &&
    helper.includes("CreateOwnedDirectory") &&
    helper.includes("CopyPinnedNew") &&
    helper.includes("PinOwnedRelative") &&
    helper.includes("PublishCreateNew")
      ? []
      : ["retained directory, owned-child, pinned-file, and publication authorities"]),
    ...(helper.indexOf("AcquirePublicationAuthority($ReceiptPath)") <
      helper.indexOf("[BharatCode.Preliminary.PinnedFileAuthority]::new()") &&
    helper.indexOf("[BharatCode.Preliminary.PinnedFileAuthority]::new()") <
      helper.indexOf("New-PreliminaryControllerLease -RunnerTemp $RunnerTemp") &&
    helper.indexOf('PinExternal("installer", $installerPath)') <
      helper.indexOf("New-PreliminaryControllerLease -RunnerTemp $RunnerTemp") &&
    helper.indexOf('PinExternal("runtime-source", $runtimeSourcePath)') <
      helper.indexOf("New-PreliminaryControllerLease -RunnerTemp $RunnerTemp") &&
    !helper.includes('$Lease.PinExternal("$Label-source", $sourcePath)') &&
    invoke.indexOf("[Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name]") <
      invoke.indexOf("Remove-PreliminaryControllerLease -Lease $lease")
      ? []
      : ["publication, immutable pins, environment restoration, and cleanup effect order"]),
    ...(helper.includes("ContentIdentity(Handle)") &&
    !helper.includes("ContentIdentity(SourcePath)") &&
    !helper.includes("[IO.File]::Copy($sourcePath, $destinationPath, $false)") &&
    !helper.includes("[IO.Directory]::CreateDirectory($paths.AcceptanceDirectory)") &&
    !helper.includes("[IO.Directory]::CreateDirectory($paths.ContractsDirectory)") &&
    !helper.includes("[IO.Directory]::CreateDirectory($paths.InputsDirectory)") &&
    !helper.includes("[IO.File]::Open($ReceiptPath, [IO.FileMode]::CreateNew")
      ? []
      : ["held-handle content, copy, owned-directory, and receipt effects"]),
    ...(tests.includes("production junction reached vulnerable copy") &&
    tests.includes("owned directory collision preceded copy") &&
    tests.includes("pinned parent substitution") &&
    tests.includes("runner temp ancestor rename") &&
    tests.includes("receipt parent substitution") &&
    tests.includes("receipt collision did not overwrite") &&
    tests.includes("late receipt collision did not overwrite") &&
    tests.includes("preliminary_controller_job_membership_diagnostic_failure") &&
    tests.includes("preliminary_controller_post_termination_control_failure") &&
    tests.includes("DACL drift cleanup") &&
    tests.includes("after-harness-stage diagnostics")
      ? []
      : ["executable C4B Windows authority and cleanup regressions"]),
  ]
}

function sourceAdmissionViolations(value: string) {
  const workflow = parse(value)
  const admission = step(value, "admit-source", "Admit immutable preliminary source").run ?? ""
  const checkouts = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((item) => item.uses === checkout),
  )
  return [
    ...(Object.keys(workflow.on).length === 1 && Object.hasOwn(workflow.on, "workflow_dispatch")
      ? []
      : ["manual-only trigger"]),
    ...(Object.keys(workflow.on.workflow_dispatch.inputs).join(",") === "source_sha" ? [] : ["closed source input"]),
    ...(workflow.jobs["admit-source"].if === "github.ref == 'refs/heads/dev'" ? [] : ["dev-only admission"]),
    ...(admission.includes('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]') &&
    admission.includes('[[ "$EVENT_SHA" == "$SOURCE_SHA" ]]') &&
    admission.includes('[[ "$GITHUB_SHA" == "$SOURCE_SHA" ]]') &&
    admission.includes('[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]')
      ? []
      : ["exact source identity"]),
    ...(admission.includes(`git merge-base --is-ancestor "$ACCEPTED_WSL_SOURCE_SHA" "$SOURCE_SHA"`) &&
    frozenWslPaths.every((path) => admission.includes(path))
      ? []
      : ["accepted WSL source closure"]),
    ...(workflow.env.SOURCE_SHA === "${{ inputs.source_sha }}" &&
    checkouts.every((item) => ["${{ inputs.source_sha }}", "${{ env.SOURCE_SHA }}"].includes(String(item.with?.ref)))
      ? []
      : ["checkout source binding"]),
  ]
}

function runArtifactBindingViolations(value: string) {
  const workflow = parse(value)
  const names = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((item) => (typeof item.with?.name === "string" ? [item.with.name] : [])),
  )
  return [
    ...(names.length === 5 && names.every((name) => name.endsWith("-${{ github.run_id }}-${{ github.run_attempt }}"))
      ? []
      : ["same-run artifact names"]),
    ...(JSON.stringify(workflow.jobs["accept-preliminary-unsigned-wsl"].needs) ===
    JSON.stringify(["admit-source", "package-preliminary-unsigned-windows"])
      ? []
      : ["acceptance producer chain"]),
  ]
}

async function externalJitBoundaryViolations(value: string) {
  const workflow = parse(value)
  const accept = workflow.jobs["accept-preliminary-unsigned-wsl"]
  const uses = [...value.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1])
  return [
    ...((await Bun.file(jitContractPath).exists()) ? [] : ["closed external lifecycle contract"]),
    ...((await Bun.file(jitControllerPath).exists()) ? [] : ["external host controller"]),
    ...(JSON.stringify(workflow.permissions) === JSON.stringify({ contents: "read" })
      ? []
      : ["read-only workflow authority"]),
    ...(workflow.jobs["require-external-jit-control-plane"] ? ["obsolete external-control-plane blocker"] : []),
    ...(workflow.jobs["admit-source"]?.needs ? ["obsolete blocker dependency"] : []),
    ...(JSON.stringify(accept?.permissions) === JSON.stringify({ contents: "read" })
      ? []
      : ["read-only preliminary acceptance authority"]),
    ...(uses.some((item) => item.startsWith("actions/attest@")) ? ["product attestation authority"] : []),
    ...(value.match(/id-token:\s*write|attestations:\s*write/iu) ? ["OIDC or attestation write authority"] : []),
    ...(value.match(/bharatcode-preliminary-jit-(?:admission|destruction).*\.json/iu)
      ? ["in-guest external lifecycle evidence channel"]
      : []),
  ]
}

describe("preliminary unsigned Windows/WSL acceptance workflow", () => {
  test("validates the exact preliminary receipt through the frozen stdin-only host adapter", async () => {
    const child = Bun.spawn([process.execPath, jitAdapterPath, "receipt"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(
      JSON.stringify({
        raw: JSON.stringify(receipt()),
        identity: { source_sha: sourceSha, run_id: bindings.run_id, run_attempt: bindings.run_attempt },
      }),
    )
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(await new Response(child.stdout).text()).toBe(canonicalPreliminaryUnsignedWslJson(receipt(), bindings))
    const duplicate = Bun.spawn([process.execPath, jitAdapterPath, "receipt"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    duplicate.stdin.write(
      JSON.stringify({
        raw: JSON.stringify(receipt()).replace(
          '"schema":"bharatcode-wsl-preliminary-unsigned-v1"',
          '"schema":"bharatcode-wsl-preliminary-unsigned-v1","schema":"bharatcode-wsl-preliminary-unsigned-v1"',
        ),
        identity: { source_sha: sourceSha, run_id: bindings.run_id, run_attempt: bindings.run_attempt },
      }),
    )
    duplicate.stdin.end()
    expect(await duplicate.exited).toBe(1)
  })

  test("removes only the obsolete blocker after an independent host controller supplies the closed JIT lifecycle", async () => {
    const value = await source()
    expect(await externalJitBoundaryViolations(value)).toEqual([])
    for (const hostile of [
      value.replace("jobs:\n", "jobs:\n  require-external-jit-control-plane:\n    runs-on: ubuntu-24.04\n"),
      value.replace("  admit-source:\n", "  admit-source:\n    needs: require-external-jit-control-plane\n"),
      value.replace("contents: read\n", "contents: write\n"),
      value.replace(
        "jobs:\n",
        "jobs:\n  forged-host-evidence:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo bharatcode-preliminary-jit-admission.json\n",
      ),
    ]) {
      expect(hostile).not.toBe(value)
      expect(await externalJitBoundaryViolations(hostile)).not.toEqual([])
    }
  })

  test("is a dedicated manual-only exact-source workflow while the final signed workflow stays byte-identical", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["source_sha"])
    expect(workflow.jobs["admit-source"].if).toBe("github.ref == 'refs/heads/dev'")
    expect(value).toContain("^[0-9a-f]{40}$")
    expect(value).toContain('[[ "$EVENT_SHA" == "$SOURCE_SHA" ]]')
    expect(value).toContain('[[ "$GITHUB_SHA" == "$SOURCE_SHA" ]]')
    expect(value).toContain("ref: ${{ inputs.source_sha }}")
    expect(value).toContain(acceptedWslSha)
    const admission = step(value, "admit-source", "Admit immutable preliminary source").run ?? ""
    for (const path of frozenWslPaths) expect(admission).toContain(path)
    expect(sha256(await Bun.file(finalWorkflowPath).arrayBuffer())).toBe(finalWorkflowSha256)
    expect(sourceAdmissionViolations(value)).toEqual([])
    for (const hostile of [
      value.replace("^[0-9a-f]{40}$", "^[0-9A-Fa-f]{40}$"),
      value.replace('[[ "$EVENT_SHA" == "$SOURCE_SHA" ]]\n', ""),
      value.replace("github.ref == 'refs/heads/dev'", "github.ref != ''"),
      value.replace("ref: ${{ env.SOURCE_SHA }}", "ref: dev"),
    ]) {
      expect(hostile).not.toBe(value)
      expect(sourceAdmissionViolations(hostile)).not.toEqual([])
    }
  })

  test("derives a disjoint immutable run-attempt runner label with no static or operator route", async () => {
    const value = await source()
    const first = renderLabels(value, "29722640762", "1")
    const second = renderLabels(value, "29722640762", "2")
    expect(first).toEqual(["self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29722640762-1"])
    expect(second).toEqual(["self-hosted", "windows", "x64", "wsl2", "bharatcode-acceptance-29722640762-2"])
    expect(first.at(-1)).not.toBe(second.at(-1))
    expect(first.at(-1)).toMatch(/^bharatcode-acceptance-[1-9][0-9]*-[1-9][0-9]*$/)
    expect(parse(value).jobs["accept-preliminary-unsigned-wsl"]["runs-on"]).toEqual([
      "self-hosted",
      "windows",
      "x64",
      "wsl2",
      label,
    ])
    expect(() => renderLabels(value.replace(label, "bharatcode-acceptance"), "29722640762", "1")).not.toThrow()
    expect(renderLabels(value.replace(label, "bharatcode-acceptance"), "29722640762", "1").at(-1)).toBe(
      renderLabels(value.replace(label, "bharatcode-acceptance"), "29722640762", "2").at(-1),
    )
    expect(JSON.stringify(parse(value).jobs["accept-preliminary-unsigned-wsl"]["runs-on"])).not.toMatch(
      /inputs\.|vars\.|secrets\./,
    )
    expect(() => renderLabels(value, "0", "1")).toThrow()
    expect(() => renderLabels(value, "1", "01")).toThrow()
    expect(runArtifactBindingViolations(value)).toEqual([])
    expect(
      runArtifactBindingViolations(
        value.replace(
          "preliminary-wsl-unsigned-windows-${{ github.run_id }}-${{ github.run_attempt }}",
          "preliminary-wsl-unsigned-windows-${{ github.run_id }}-1",
        ),
      ),
    ).not.toEqual([])
  })

  test("builds an unsigned NSIS, installs it in a create-only isolated root, and runs the installed app with raw runtime inputs", async () => {
    const value = await source()
    expect(installedAcceptanceViolations(value)).toEqual([])
    for (const hostile of [
      value.replace('BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "1"', 'BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "0"'),
      value.replace("electron-builder --win nsis --x64", "electron-builder --win dir --x64"),
      value.replace('Status -ne "NotSigned"', 'Status -ne "Valid"'),
      value.replace("Invoke-PreliminaryController `", "Start-Process `"),
      value.replace(
        '"--desktop-exe", process.env.INSTALLED_DESKTOP_EXE',
        '"--desktop-exe", process.env.UNSIGNED_INSTALLER_PATH',
      ),
      value.replace("            bharatcode-runtime-linux-x64-glibc\n", ""),
      value.replace("sha256: result.evidence.desktop_sha256", "sha256: bindings.installed_desktop_sha256"),
      value.replace(
        "const result = await runPreliminaryWindowsAcceptance(argv)",
        "const result = await runWindowsAcceptance(argv)",
      ),
      value.replace("authority: result.harness_authority", "authority: result.authority"),
      value.replace("cleanup_complete: true", "cleanup_complete: false"),
    ]) {
      expect(hostile).not.toBe(value)
      expect(installedAcceptanceViolations(hostile)).not.toEqual([])
    }
  })

  test("restores immutable runtime inputs after artifact transport", async () => {
    const staging = step(
      await source(),
      "package-preliminary-unsigned-windows",
      "Install exact dependencies and stage same-source runtime",
    ).run
    expect(staging).toContain("$runtime = (Resolve-Path preliminary-runtime/bharatcode-runtime-linux-x64-glibc).Path")
    expect(staging).toContain("$manifest = (Resolve-Path preliminary-runtime/manifest.json).Path")
    expect(staging).toContain("Set-ItemProperty -LiteralPath $runtime -Name IsReadOnly -Value $true")
    expect(staging).toContain("Set-ItemProperty -LiteralPath $manifest -Name IsReadOnly -Value $true")
    expect(staging!.indexOf("Set-ItemProperty")).toBeLessThan(staging!.indexOf("stage:wsl-runtime"))
  })

  test("uses the repository-supported Windows packaging toolchain", async () => {
    const workflow = parse(await source())
    expect(workflow.jobs["package-preliminary-unsigned-windows"]["runs-on"]).toBe("windows-2022")
    expect(workflow.jobs["accept-preliminary-unsigned-wsl"]["runs-on"]).toEqual([
      "self-hosted",
      "windows",
      "x64",
      "wsl2",
      label,
    ])
  })

  test("keeps one unguessable handle-bound namespace authority through evidence and runs executable Windows hostile tests", async () => {
    const value = await source()
    expect(await namespaceAuthorityViolations(value)).toEqual([])
  })

  test("retains handle-relative RUNNER_TEMP authority and keeps every mutable transaction artifact under the lease", async () => {
    const value = await source()
    expect(await controllerC1Violations(value)).toEqual([])
  })

  test("separates process stages, pins immutable inputs, and uses the real NSIS create-only install contract", async () => {
    const value = await source()
    expect(await controllerC2Violations(value)).toEqual([])
  })

  test("drives every controlled failure through the real controller and leaves crashes for external JIT destruction", async () => {
    const value = await source()
    expect(await controllerC3Violations(value)).toEqual([])
  })

  test("keeps every Windows preliminary filesystem effect under retained handle authority", async () => {
    expect(await controllerC4BViolations()).toEqual([])
  })

  test("executes the actual evidence script with a held harness path and emits the fixed logical contract", async () => {
    const value = await source()
    const transaction =
      step(value, "accept-preliminary-unsigned-wsl", "Run one handle-bound installed Desktop preliminary transaction")
        .run ?? ""
    const extracted = transaction.match(
      /\$evidenceScript = @'\n([\s\S]*?)\n\s*'@\n\s*Invoke-PreliminaryController/u,
    )?.[1]
    expect(extracted).toBeString()

    const directory = await mkdtemp(join(tmpdir(), "bcp-c4a-evidence-"))
    try {
      const contracts = join(directory, "contracts")
      const inputs = join(directory, "inputs")
      await mkdir(contracts)
      await mkdir(inputs)
      const evidence = join(directory, "evidence.mjs")
      const adapter = join(contracts, "wsl-windows-preliminary-acceptance.mjs")
      const validator = join(contracts, "lean-preliminary-unsigned-wsl.mjs")
      const harness = join(contracts, "wsl-windows-acceptance.mjs")
      const manifest = join(inputs, "manifest.json")
      const runtime = join(inputs, "runtime.bin")
      const installer = join(inputs, "installer.exe")
      const desktop = join(inputs, "BharatCode Beta.exe")
      const candidate = join(directory, "receipt-candidate.json")
      await Bun.write(evidence, extracted ?? "")
      await Bun.write(
        validator,
        await Bun.file(resolve(root, "packages/opencode/script/lean-preliminary-unsigned-wsl.mjs")).text(),
      )
      await Bun.write(harness, "export const heldHarness = true\n")
      await Bun.write(manifest, "manifest-bytes")
      await Bun.write(runtime, "runtime-bytes")
      await Bun.write(installer, "installer-bytes")
      await Bun.write(desktop, "desktop-bytes")
      const runtimeSha256 = sha256(await Bun.file(runtime).arrayBuffer())
      const manifestSha256 = sha256(await Bun.file(manifest).arrayBuffer())
      const desktopSha256 = sha256(await Bun.file(desktop).arrayBuffer())
      await Bun.write(
        adapter,
        `import "./wsl-windows-acceptance.mjs"
export async function runPreliminaryWindowsAcceptance() { return ${JSON.stringify({
          authority: "PRELIMINARY_UNSIGNED",
          harness_authority: "DIAGNOSTIC",
          evidence: {
            source_sha: sourceSha,
            desktop_sha256: desktopSha256,
            runtime_manifest_sha256: manifestSha256,
            runtime: {
              manifest_source_sha: sourceSha,
              executed_source_sha: sourceSha,
              manifest_sha256: runtimeSha256,
              executed_sha256: runtimeSha256,
            },
            identity: { distro_sha256: "5".repeat(64), user_sha256: "6".repeat(64), uid: 1000 },
            scenarios: { "9": true, "10": true },
            completed_at: "2026-07-20T10:00:00.000Z",
          },
        })} }\n`,
      )
      const child = Bun.spawn([process.execPath, evidence], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_RUN_ATTEMPT: bindings.run_attempt,
          GITHUB_RUN_ID: bindings.run_id,
          INSTALLED_DESKTOP_EXE: desktop,
          PRELIMINARY_ACCEPTANCE_DIR: join(directory, "acceptance"),
          PRELIMINARY_ADAPTER: adapter,
          PRELIMINARY_EVIDENCE_SCRIPT: evidence,
          PRELIMINARY_FROZEN_HARNESS: harness,
          PRELIMINARY_RECEIPT_CANDIDATE: candidate,
          PRELIMINARY_RUNTIME: runtime,
          PRELIMINARY_RUNTIME_MANIFEST: manifest,
          PRELIMINARY_VALIDATOR: validator,
          SOURCE_SHA: sourceSha,
          UNSIGNED_INSTALLER_PATH: installer,
          WORKFLOW_PATH: ".github/workflows/bharatcode-preliminary-unsigned-wsl.yml",
          WSL_DISTRIBUTION: "Ubuntu 24.04",
          WSL_INVALID_DISTRIBUTION: "Invalid Root",
          WSL_MISSING_PREREQUISITE_DISTRIBUTION: "Missing Tool",
          WSL_WINDOWS_PROJECT: "C:\\acceptance\\project",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, standardError] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(exitCode, standardError).toBe(0)
      const emitted = JSON.parse(await Bun.file(candidate).text())
      expect(emitted.harness).toEqual({
        contract: "packages/desktop/scripts/wsl-windows-acceptance.mjs",
        contract_sha256: sha256(await Bun.file(harness).arrayBuffer()),
        authority: "DIAGNOSTIC",
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("validates and canonically serializes one closed non-promotable receipt", async () => {
    const value = receipt()
    expect(validatePreliminaryUnsignedWslReceipt(value, bindings)).toEqual(value)
    expect(canonicalPreliminaryUnsignedWslJson(value, bindings)).toBe(`${JSON.stringify(value)}\n`)
    const canonical = canonicalPreliminaryUnsignedWslJson(value, bindings)
    const permuted = canonicalPreliminaryUnsignedWslJson(reverseKeys(value), bindings)
    expect(permuted).toBe(canonical)
    expect(sha256(permuted)).toBe(sha256(canonical))
    const parseRaw = Reflect.get(
      await import("../../script/lean-preliminary-unsigned-wsl.mjs"),
      "parsePreliminaryUnsignedWslJson",
    )
    expect(parseRaw).toBeFunction()
    const duplicate = canonicalPreliminaryUnsignedWslJson(value, bindings).replace(
      '"schema":"bharatcode-wsl-preliminary-unsigned-v1"',
      '"schema":"bharatcode-wsl-preliminary-unsigned-v1","schema":"bharatcode-wsl-preliminary-unsigned-v1"',
    )
    expect(() => parseRaw(duplicate, bindings)).toThrow(/duplicate/iu)
    expect(() => parseRaw(`${JSON.stringify({ ...value, extra: true })}\n`, bindings)).toThrow()
    for (const hostile of [
      { ...value, extra: true },
      { ...value, schema: "bharatcode-wsl-scenarios-9-10-v1" },
      { ...value, result: "PASS" },
      { ...value, signature_status: "NotSigned" },
      { ...value, provenance_status: "SLSA" },
      { ...value, cleanup_complete: false },
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cleanup_complete")),
      { ...value, promotable: true },
      { ...value, composable: true },
      { ...value, controller_inputs: { ...value.controller_inputs, adapter_sha256: "0".repeat(64) } },
      { ...value, source_sha: "8".repeat(40) },
      { ...value, github: { ...value.github, run_attempt: 1 } },
      { ...value, unsigned_installer: { ...value.unsigned_installer, sha256: "0".repeat(64) } },
      { ...value, installed_desktop: { ...value.installed_desktop, sha256: "0".repeat(64) } },
      { ...value, runtime: { ...value.runtime, executed_sha256: "0".repeat(64) } },
      { ...value, harness: { ...value.harness, authority: "PASS" } },
      { ...value, identity: { ...value.identity, uid: 0 } },
      { ...value, scenarios: { "9": true, "10": false } },
    ]) {
      expect(() => validatePreliminaryUnsignedWslReceipt(hostile, bindings)).toThrow()
    }
    expect(() =>
      validateLeanWslReceipt(value, {
        source_sha: bindings.source_sha,
        run_id: bindings.run_id,
        run_attempt: bindings.run_attempt,
        desktop_sha256: bindings.installed_desktop_sha256,
        runtime_manifest_sha256: bindings.runtime_manifest_sha256,
      }),
    ).toThrow()
    expect(() =>
      validateLeanCohort(value, {
        source_sha: bindings.source_sha,
        run_id: bindings.run_id,
        run_attempt: bindings.run_attempt,
      }),
    ).toThrow()
  })

  test("uploads only private preliminary evidence with no attestation, final-cohort, or publication authority", async () => {
    const value = await source()
    const workflow = parse(value)
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      [
        "accept-preliminary-unsigned-wsl",
        "admit-source",
        "build-wsl-runtime",
        "package-preliminary-unsigned-windows",
      ].sort(),
    )
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.jobs["accept-preliminary-unsigned-wsl"].permissions).toEqual({ contents: "read" })
    const uses = [...value.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1])
    expect(new Set(uses)).toEqual(new Set([checkout, setupBun, upload, download]))
    expect(uses.every((item) => /@[0-9a-f]{40}$/u.test(item))).toBeTrue()
    expect(value).not.toMatch(
      /cp2-|wsl-scenarios-9-10|wsl_receipt_sha256|bharatcode-next-beta-cohort|assemble-cohort/iu,
    )
    expect(value).not.toMatch(/gh\s+release|npm\s+publish|repository_dispatch|workflow_run|workflow_call|ShareNext/iu)
    expect(value).not.toMatch(/contents:\s*write|packages:\s*write|deployments:\s*write/iu)
    const uploadStep = step(value, "accept-preliminary-unsigned-wsl", "Upload run-attempt-scoped preliminary evidence")
    expect(uploadStep.with?.name).toBe("preliminary-wsl-evidence-${{ github.run_id }}-${{ github.run_attempt }}")
    expect(uploadStep.with?.path).toBe("bharatcode-wsl-preliminary-unsigned.json")
    const otherWorkflows = readdirSync(resolve(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/u.test(name) && name !== "bharatcode-preliminary-unsigned-wsl.yml")
      .map((name) => Bun.file(resolve(root, ".github/workflows", name)).text())
    return Promise.all(otherWorkflows).then((sources) => {
      expect(sources.join("\n")).not.toMatch(
        /bharatcode-wsl-preliminary-unsigned-v1|bharatcode-wsl-preliminary-unsigned\.json|preliminary-wsl-evidence-/u,
      )
    })
  })
})
