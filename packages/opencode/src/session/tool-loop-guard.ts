import { createHash } from "node:crypto"
import { MessageV2 } from "./message-v2"

const DEFAULT_THRESHOLD = 3
const DEFAULT_RECENT_MESSAGES = 80

export interface RepeatedFailure {
  tool: string
  count: number
  threshold: number
  inputFingerprint: string
  errorFingerprints: string[]
}

export class RepeatedToolCallError extends Error {
  constructor(readonly failure: RepeatedFailure) {
    super(message(failure))
    this.name = "RepeatedToolCallError"
  }
}

export function repeatedFailure(input: {
  messages: MessageV2.WithParts[]
  tool: string
  input: Record<string, unknown>
  threshold?: number
  recentMessages?: number
}): RepeatedFailure | undefined {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD
  const inputHash = inputFingerprint(input.input)
  const matches = input.messages
    .slice(-(input.recentMessages ?? DEFAULT_RECENT_MESSAGES))
    .flatMap((msg) => msg.parts)
    .filter((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateError } => {
      if (part.type !== "tool") return false
      if (part.tool !== input.tool) return false
      if (part.state.status !== "error") return false
      return inputFingerprint(part.state.input) === inputHash
    })

  if (matches.length < threshold) return

  return {
    tool: input.tool,
    count: matches.length,
    threshold,
    inputFingerprint: inputHash,
    errorFingerprints: [...new Set(matches.map((part) => errorFingerprint(part.state.error)))].slice(0, 3),
  }
}

export function inputFingerprint(input: unknown) {
  return fingerprint(stableJson(input))
}

export function message(failure: RepeatedFailure) {
  return [
    `Stopped automatic tool execution because ${failure.tool} has already failed ${failure.count} times with the same input.`,
    "Try a different approach or ask the user for guidance before retrying.",
  ].join(" ")
}

export function metadata(failure: RepeatedFailure): Record<string, unknown> {
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

function errorFingerprint(error: string) {
  return fingerprint(error)
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function stableJson(input: unknown) {
  try {
    return JSON.stringify(stableValue(input)) ?? "undefined"
  } catch {
    return String(input)
  }
}

function stableValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stableValue)
  if (!isRecord(input)) return input
  return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stableValue(input[key])]))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

export * as ToolLoopGuard from "./tool-loop-guard"
