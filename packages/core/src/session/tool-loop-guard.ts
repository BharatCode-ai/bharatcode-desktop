import { createHash } from "node:crypto"

export interface Failure {
  tool: string
  input: unknown
  error: unknown
}

export interface RepeatedFailure {
  tool: string
  count: number
  threshold: number
  inputFingerprint: string
  errorFingerprints: string[]
}

export function repeatedFailure(
  failures: readonly Failure[],
  tool: string,
  input: unknown,
): RepeatedFailure | undefined {
  const inputHash = inputFingerprint(input)
  if (!inputHash) return
  const matches = failures.filter((failure) => failure.tool === tool && inputFingerprint(failure.input) === inputHash)
  if (matches.length < 3) return
  return {
    tool,
    count: matches.length,
    threshold: 3,
    inputFingerprint: inputHash,
    errorFingerprints: [
      ...new Set(
        matches.flatMap((failure) => {
          const value = inputFingerprint(failure.error)
          return value ? [value] : []
        }),
      ),
    ].slice(0, 3),
  }
}

export function message(failure: RepeatedFailure) {
  return `Stopped automatic tool execution because ${failure.tool} has already failed ${failure.count} times with the same input. Try a different approach or ask the user for guidance before retrying.`
}

export function metadata(failure: RepeatedFailure) {
  return {
    toolLoopGuard: {
      type: "repeated_failed_tool_call",
      tool: failure.tool,
      repeatCount: failure.count,
      threshold: failure.threshold,
      inputFingerprint: failure.inputFingerprint,
      errorFingerprints: failure.errorFingerprints,
    },
  }
}

export function inputFingerprint(input: unknown): string | undefined {
  try {
    const value = JSON.stringify(stableValue(input))
    return value === undefined ? undefined : createHash("sha256").update(value).digest("hex").slice(0, 16)
  } catch {
    return undefined
  }
}

function stableValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stableValue)
  if (typeof input !== "object" || input === null) return input
  return Object.fromEntries(
    Object.entries(input)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, stableValue(value)]),
  )
}
