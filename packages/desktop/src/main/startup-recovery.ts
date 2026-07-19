import { execFile } from "node:child_process"
import path from "node:path"

export type RecoverySource = { id: string; label: string; contentFingerprint: string }
export type RecoveryPayload =
  | { state: "ready" }
  | { state: "choose-source"; sources: readonly RecoverySource[] }
  | { state: "retry"; operationID: string }
  | { state: "start-fresh"; reason: "no-source" | "ambiguous" | "interrupted" | "invalid-marker" }
  | {
      state: "marker-repair"
      diagnosis: "missing" | "invalid" | "unreadable" | "permission-invalid" | "schema-mismatch"
      inferredVersion?: string
    }
  | { state: "blocked"; reason: "corrupt" | "incompatible" | "destination-mutated" }

export type RecoveryAction =
  | { type: "choose-source"; id: string; contentFingerprint: string }
  | { type: "retry"; operationID: string }
  | { type: "start-fresh"; confirmed: true }
  | { type: "repair-marker"; confirmed: true }

type Invoke = (executable: string, args: readonly string[]) => Promise<string>

export class StartupRecoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeStartupRecoveryError"
  }
}

export function createStartupRecovery(input: { executable: string; invoke?: Invoke }) {
  if (!path.isAbsolute(input.executable)) throw new StartupRecoveryError("The recovery runtime was unavailable.")
  const invoke = input.invoke ?? invokeExact
  let active: { key: string; promise: Promise<RecoveryPayload> } | undefined
  const waiters = new Set<() => void>()

  const settle = (result: RecoveryPayload) => {
    if (result.state === "ready") {
      for (const resolve of waiters) resolve()
      waiters.clear()
    }
    return result
  }
  const inspect = () => execute(invoke, input.executable, ["recovery", "status", "--json"]).then(settle)
  const run = (value: RecoveryAction) => {
    const action = parseRecoveryAction(value)
    const key = JSON.stringify(action)
    if (active) {
      if (active.key !== key)
        return Promise.reject(new StartupRecoveryError("A recovery operation is already in progress."))
      return active.promise
    }
    const promise = execute(invoke, input.executable, actionArguments(action))
      .then(settle)
      .finally(() => {
        if (active?.promise === promise) active = undefined
      })
    active = { key, promise }
    return promise
  }
  const waitUntilReady = (initial: RecoveryPayload) => {
    if (initial.state === "ready") return Promise.resolve()
    return new Promise<void>((resolve) => waiters.add(resolve))
  }
  return { inspect, run, waitUntilReady, inFlight: () => active !== undefined }
}

export function parseRecoveryAction(value: unknown): RecoveryAction {
  if (!record(value) || typeof value.type !== "string") throw invalid()
  if (value.type === "choose-source") {
    exactKeys(value, ["type", "id", "contentFingerprint"])
    if (!safeToken(value.id, 160) || !digest(value.contentFingerprint)) throw invalid()
    return { type: "choose-source", id: value.id, contentFingerprint: value.contentFingerprint }
  }
  if (value.type === "retry") {
    exactKeys(value, ["type", "operationID"])
    if (!uuid(value.operationID)) throw invalid()
    return { type: "retry", operationID: value.operationID }
  }
  if (value.type !== "start-fresh" && value.type !== "repair-marker") throw invalid()
  exactKeys(value, ["type", "confirmed"])
  if (value.confirmed !== true) throw invalid()
  return { type: value.type, confirmed: true }
}

export function bundledRecoveryExecutable(resourcesPath: string, platform = process.platform) {
  if (!path.isAbsolute(resourcesPath)) throw new StartupRecoveryError("The recovery runtime was unavailable.")
  return path.join(resourcesPath, `bharatcode-opencode-cli${platform === "win32" ? ".exe" : ""}`)
}

export function parseRecoveryPayload(raw: string): RecoveryPayload {
  try {
    return parseResult(JSON.parse(raw.trim()))
  } catch (error) {
    if (error instanceof StartupRecoveryError) throw error
    throw invalid()
  }
}

function actionArguments(action: RecoveryAction): readonly string[] {
  if (action.type === "choose-source") {
    if (!safeToken(action.id, 160) || !digest(action.contentFingerprint)) throw invalid()
    return [
      "recovery",
      "choose-source",
      "--id",
      action.id,
      "--content-fingerprint",
      action.contentFingerprint,
      "--json",
    ]
  }
  if (action.type === "retry") {
    if (!uuid(action.operationID)) throw invalid()
    return ["recovery", "retry", "--operation-id", action.operationID, "--json"]
  }
  if (action.confirmed !== true) throw invalid()
  return action.type === "start-fresh"
    ? ["recovery", "start-fresh", "--confirm", "--json"]
    : ["doctor", "repair", "--confirm", "--json"]
}

async function execute(invoke: Invoke, executable: string, args: readonly string[]) {
  try {
    return parseRecoveryPayload(await invoke(executable, args))
  } catch (error) {
    if (error instanceof StartupRecoveryError) throw error
    throw new StartupRecoveryError("BharatCode recovery did not complete safely.")
  }
}

function invokeExact(executable: string, args: readonly string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 1_048_576, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

function parseResult(value: unknown): RecoveryPayload {
  if (!record(value) || typeof value.state !== "string") throw invalid()
  if (value.state === "ready") {
    exactKeys(value, ["state"])
    return { state: "ready" }
  }
  if (value.state === "retry") {
    exactKeys(value, ["state", "operationID"])
    if (!uuid(value.operationID)) throw invalid()
    return { state: "retry", operationID: value.operationID }
  }
  if (value.state === "start-fresh") {
    exactKeys(value, ["state", "reason"])
    if (!freshReason(value.reason)) throw invalid()
    return { state: "start-fresh", reason: value.reason }
  }
  if (value.state === "blocked") {
    exactKeys(value, ["state", "reason"])
    if (value.reason !== "corrupt" && value.reason !== "incompatible" && value.reason !== "destination-mutated") {
      throw invalid()
    }
    return { state: "blocked", reason: value.reason }
  }
  if (value.state === "marker-repair") {
    exactKeys(
      value,
      value.inferredVersion === undefined ? ["state", "diagnosis"] : ["state", "diagnosis", "inferredVersion"],
    )
    if (!markerState(value.diagnosis)) throw invalid()
    if (value.inferredVersion !== undefined && !safeToken(value.inferredVersion, 128)) throw invalid()
    return {
      state: "marker-repair",
      diagnosis: value.diagnosis,
      ...(typeof value.inferredVersion === "string" ? { inferredVersion: value.inferredVersion } : {}),
    }
  }
  if (value.state !== "choose-source") throw invalid()
  exactKeys(value, ["state", "sources"])
  if (!Array.isArray(value.sources) || value.sources.length > 16) throw invalid()
  const sources = value.sources.map((source) => {
    if (!record(source)) throw invalid()
    exactKeys(source, ["id", "label", "contentFingerprint"])
    if (!safeToken(source.id, 160) || !safeLabel(source.label) || !digest(source.contentFingerprint)) throw invalid()
    return { id: source.id, label: source.label, contentFingerprint: source.contentFingerprint }
  })
  return { state: "choose-source", sources }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).toSorted()
  const expected = [...keys].toSorted()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid()
}

function safeToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n\\/]/.test(value)
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\0\r\n\\/]/.test(value)
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function freshReason(value: unknown): value is "no-source" | "ambiguous" | "interrupted" | "invalid-marker" {
  return value === "no-source" || value === "ambiguous" || value === "interrupted" || value === "invalid-marker"
}

function markerState(
  value: unknown,
): value is "missing" | "invalid" | "unreadable" | "permission-invalid" | "schema-mismatch" {
  return (
    value === "missing" ||
    value === "invalid" ||
    value === "unreadable" ||
    value === "permission-invalid" ||
    value === "schema-mismatch"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function invalid(): StartupRecoveryError {
  return new StartupRecoveryError("The BharatCode CLI returned an invalid recovery result.")
}
