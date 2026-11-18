// Exportable diagnostics are constructed from an allowlist, never redacted raw logs.
export const supportEventNames = [
  "backend_started",
  "backend_stopped",
  "backend_error",
  "request_started",
  "request_failed",
  "retry_scheduled",
  "request_completed",
  "request_cancelled",
  "tool_replay_prevented",
] as const

const codes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ENOTFOUND",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "TLS_ERROR",
  "FETCH_FAILED",
  "BHARATCODE_TRANSPORT",
  "HTTP_ERROR",
  "UNKNOWN_ERROR",
  "CANCELLED",
  "BACKEND_START_FAILED",
  "BACKEND_EXIT",
  "NORMAL_EXIT",
  "CONTEXT_OVERFLOW",
  "OUTPUT_LIMIT",
])

export type SupportEvent = NonNullable<ReturnType<typeof supportEvent>>

export function supportEvents(input: unknown, now = Date.now()): SupportEvent[] {
  if (!Array.isArray(input)) return []
  return input.slice(-200).flatMap((value) => {
    const event = supportEvent(value)
    if (!event) return []
    const time = Date.parse(event.time)
    return time > now - 24 * 60 * 60 * 1000 && time <= now ? [event] : []
  })
}

export function supportEvent(input: unknown) {
  if (!input || typeof input !== "object") return
  const value = input as Record<string, unknown>
  const event = supportEventNames.find((name) => name === value.event)
  if (
    !event ||
    typeof value.time !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time) ||
    !Number.isFinite(Date.parse(value.time))
  )
    return
  return {
    time: value.time,
    event,
    model:
      ["glm-5.3-flash", "qwen-3.8-27b", "deepseek-v3.2", "deepseek-v4-flash"].find((name) => name === value.model) ??
      "other",
    code: typeof value.code === "string" && codes.has(value.code) ? value.code : null,
    status: integer(value.status, 100, 599),
    requestId: uuid(value.requestId),
    operationId: uuid(value.operationId),
    attempt: integer(value.attempt, 1, 6),
    retryable: typeof value.retryable === "boolean" ? value.retryable : null,
    toolStarted: typeof value.toolStarted === "boolean" ? value.toolStarted : null,
  }
}

function integer(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

function uuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null
}
