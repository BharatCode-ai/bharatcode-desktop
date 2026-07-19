export const WSL_ERROR_CODES = [
  "wsl-unavailable",
  "no-wsl2-distribution",
  "selection-required",
  "selection-invalid",
  "root-user",
  "prerequisite-missing",
  "runtime-integrity",
  "path-translation",
  "start-failed",
  "connection-lost",
  "stop-failed",
] as const

export type WslErrorCode = (typeof WSL_ERROR_CODES)[number]

export type WslStatus = { phase: "off" | "ready" | "starting" | "running" } | { phase: "error"; code: WslErrorCode }

export type WslSnapshot = {
  enabled: boolean
  revision: number
  selectedDisplayName?: string
  distributions: Array<{ displayName: string; version: 2; selected: boolean }>
  status: WslStatus
}

export type WslStoredState =
  | { schema: 1; enabled: false; revision: number }
  | { schema: 1; enabled: true; revision: number; selectedDisplayName: string }

export type WslConfigurationUpdate =
  | { enabled: false; expectedRevision: number }
  | { enabled: true; expectedRevision: number; selectedDisplayName: string }

export type WslMainDistribution = {
  displayName: string
  version: number
  running: boolean
  instanceId?: string
  instanceIdSha256?: string
  user?: string
  uid?: number
}

const defaultState = (): WslStoredState => ({ schema: 1, enabled: false, revision: 0 })

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function isSafeWslDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !value.startsWith("-") &&
    !/[\u0000-\u001f\u007f/\\]/u.test(value)
  )
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function parseStoredWslState(value: unknown): WslStoredState {
  if (isExactRecord(value, ["schema", "enabled", "revision"])) {
    if (value.schema === 1 && value.enabled === false && isRevision(value.revision)) {
      return { schema: 1, enabled: false, revision: value.revision }
    }
    return defaultState()
  }

  if (isExactRecord(value, ["schema", "enabled", "revision", "selectedDisplayName"])) {
    if (
      value.schema === 1 &&
      value.enabled === true &&
      isRevision(value.revision) &&
      isSafeWslDisplayName(value.selectedDisplayName)
    ) {
      return {
        schema: 1,
        enabled: true,
        revision: value.revision,
        selectedDisplayName: value.selectedDisplayName,
      }
    }
  }

  return defaultState()
}

export function parseWslConfigurationUpdate(value: unknown): WslConfigurationUpdate {
  if (isExactRecord(value, ["enabled", "expectedRevision"])) {
    if (value.enabled === false && isRevision(value.expectedRevision)) {
      return { enabled: false, expectedRevision: value.expectedRevision }
    }
  }

  if (isExactRecord(value, ["enabled", "expectedRevision", "selectedDisplayName"])) {
    if (
      value.enabled === true &&
      isRevision(value.expectedRevision) &&
      isSafeWslDisplayName(value.selectedDisplayName)
    ) {
      return {
        enabled: true,
        expectedRevision: value.expectedRevision,
        selectedDisplayName: value.selectedDisplayName,
      }
    }
  }

  throw new Error("Invalid WSL configuration update")
}

export class WslRevisionConflict extends Error {
  constructor() {
    super("WSL configuration revision conflict")
    this.name = "WslRevisionConflict"
  }
}

export function applyWslConfigurationUpdate(state: WslStoredState, update: WslConfigurationUpdate): WslStoredState {
  if (state.revision !== update.expectedRevision) throw new WslRevisionConflict()
  const revision = state.revision + 1
  if (!update.enabled) return { schema: 1, enabled: false, revision }
  if (!isSafeWslDisplayName(update.selectedDisplayName)) throw new Error("Invalid WSL distribution name")
  return { schema: 1, enabled: true, revision, selectedDisplayName: update.selectedDisplayName }
}

export function toWslSnapshot(input: {
  stored: WslStoredState
  distributions: readonly WslMainDistribution[]
  status: WslStatus
  privateRuntime?: unknown
}): WslSnapshot {
  const selectedDisplayName = input.stored.enabled ? input.stored.selectedDisplayName : undefined
  return {
    enabled: input.stored.enabled,
    revision: input.stored.revision,
    ...(selectedDisplayName ? { selectedDisplayName } : {}),
    distributions: input.distributions
      .filter((distribution) => distribution.version === 2)
      .map((distribution) => ({
        displayName: distribution.displayName,
        version: 2,
        selected: distribution.displayName === selectedDisplayName,
      })),
    status: input.status,
  }
}
