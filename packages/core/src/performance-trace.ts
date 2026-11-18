export * as PerformanceTrace from "./performance-trace"

import { Flag } from "./flag/flag"

export type TimingPoint =
  | "user_prompt_submit"
  | "request_construction"
  | "network_start"
  | "first_stream_event"
  | "first_token_parsed"
  | "first_token_emitted"

export interface TimingMark {
  point: TimingPoint
  timestamp: number
  elapsedMs: number
}

export interface TraceSummary {
  sessionID: string
  messageID?: string
  modelID?: string
  providerID?: string
  totalTtftMs: number
  marks: Partial<Record<TimingPoint, number>>
  durations: {
    promptToRequestConstructionMs?: number
    requestConstructionToNetworkStartMs?: number
    networkStartToFirstStreamEventMs?: number
    firstStreamEventToFirstTokenParsedMs?: number
    firstTokenParsedToEmittedMs?: number
  }
}

export interface TraceMetadata {
  messageID?: string
  modelID?: string
  providerID?: string
}

export type TraceState = {
  sessionID: string
  metadata: TraceMetadata
  startTime: number
  marks: Map<TimingPoint, number>
  completed: boolean
  summary?: TraceSummary
}

const MAX_ACTIVE_TRACES = 100
const MAX_COMPLETED_TRACES = 100

const activeTraces = new Map<string, TraceState>()
const completedTraces = new Map<string, TraceState>()
const listeners = new Set<(summary: TraceSummary) => void>()

export function isEnabled(): boolean {
  return Flag.OPENCODE_PERF_TRACE
}

export function activeTraceCount(): number {
  return activeTraces.size
}

export function completedTraceCount(): number {
  return completedTraces.size
}

export function start(sessionID: string, metadata?: TraceMetadata): void {
  if (!isEnabled()) return

  completedTraces.delete(sessionID)

  if (activeTraces.size >= MAX_ACTIVE_TRACES) {
    const oldest = activeTraces.keys().next().value
    if (oldest) activeTraces.delete(oldest)
  }

  const now = performance.now()
  const trace: TraceState = {
    sessionID,
    metadata: { ...metadata },
    startTime: now,
    marks: new Map([["user_prompt_submit", now]]),
    completed: false,
  }
  activeTraces.set(sessionID, trace)
}

export function mark(sessionID: string, point: TimingPoint, metadata?: TraceMetadata): void {
  if (!isEnabled()) return

  // Subsequent tokens in an already-completed turn are safe no-ops
  if (completedTraces.has(sessionID)) return

  let trace = activeTraces.get(sessionID)
  const now = performance.now()

  if (!trace) {
    if (activeTraces.size >= MAX_ACTIVE_TRACES) {
      const oldest = activeTraces.keys().next().value
      if (oldest) activeTraces.delete(oldest)
    }
    trace = {
      sessionID,
      metadata: { ...metadata },
      startTime: now,
      marks: new Map(),
      completed: false,
    }
    activeTraces.set(sessionID, trace)
  } else if (metadata) {
    Object.assign(trace.metadata, metadata)
  }

  // Record timing mark only on first occurrence per turn
  if (!trace.marks.has(point)) {
    trace.marks.set(point, now)
  }

  if (point === "first_token_emitted" && !trace.completed) {
    complete(sessionID)
  }
}

export function complete(sessionID: string): TraceSummary | undefined {
  if (!isEnabled()) return undefined

  const trace = activeTraces.get(sessionID) ?? completedTraces.get(sessionID)
  if (!trace) return undefined
  if (trace.completed && trace.summary) return trace.summary

  trace.completed = true
  const marksObj: Partial<Record<TimingPoint, number>> = {}
  for (const [point, time] of trace.marks) {
    marksObj[point] = Math.round((time - trace.startTime) * 100) / 100
  }

  const promptSubmit = trace.marks.get("user_prompt_submit") ?? trace.startTime
  const requestConstruction = trace.marks.get("request_construction")
  const networkStart = trace.marks.get("network_start")
  const firstStreamEvent = trace.marks.get("first_stream_event")
  const firstTokenParsed = trace.marks.get("first_token_parsed")
  const firstTokenEmitted = trace.marks.get("first_token_emitted") ?? performance.now()

  const round = (val: number | undefined) => (val === undefined ? undefined : Math.round(Math.max(0, val) * 100) / 100)

  const parseToEmit = round(
    firstTokenEmitted !== undefined && firstTokenParsed !== undefined
      ? firstTokenEmitted - firstTokenParsed
      : undefined,
  )

  const summary: TraceSummary = {
    sessionID: trace.sessionID,
    messageID: trace.metadata.messageID,
    modelID: trace.metadata.modelID,
    providerID: trace.metadata.providerID,
    totalTtftMs: Math.round((firstTokenEmitted - promptSubmit) * 100) / 100,
    marks: marksObj,
    durations: {
      promptToRequestConstructionMs: round(
        requestConstruction !== undefined ? requestConstruction - promptSubmit : undefined,
      ),
      requestConstructionToNetworkStartMs: round(
        networkStart !== undefined && requestConstruction !== undefined
          ? networkStart - requestConstruction
          : undefined,
      ),
      networkStartToFirstStreamEventMs: round(
        firstStreamEvent !== undefined && networkStart !== undefined ? firstStreamEvent - networkStart : undefined,
      ),
      firstStreamEventToFirstTokenParsedMs: round(
        firstTokenParsed !== undefined && firstStreamEvent !== undefined
          ? firstTokenParsed - firstStreamEvent
          : undefined,
      ),
      firstTokenParsedToEmittedMs: parseToEmit,
    },
  }

  // Strictly telemetry/timing only; zero prompt text or token content is ever logged
  console.info(
    `[PERF_TRACE:TTFT] sessionID=${summary.sessionID} totalTtftMs=${summary.totalTtftMs}` +
      (summary.providerID ? ` provider=${summary.providerID}` : "") +
      (summary.modelID ? ` model=${summary.modelID}` : "") +
      ` prompt_to_req=${summary.durations.promptToRequestConstructionMs ?? "n/a"}ms` +
      ` req_to_net=${summary.durations.requestConstructionToNetworkStartMs ?? "n/a"}ms` +
      ` net_to_stream=${summary.durations.networkStartToFirstStreamEventMs ?? "n/a"}ms` +
      ` stream_to_parse=${summary.durations.firstStreamEventToFirstTokenParsedMs ?? "n/a"}ms` +
      ` parse_to_emit=${summary.durations.firstTokenParsedToEmittedMs ?? "n/a"}ms`,
  )

  trace.summary = summary

  activeTraces.delete(sessionID)
  if (completedTraces.size >= MAX_COMPLETED_TRACES) {
    const oldest = completedTraces.keys().next().value
    if (oldest) completedTraces.delete(oldest)
  }
  completedTraces.set(sessionID, trace)

  for (const listener of listeners) {
    try {
      listener(summary)
    } catch {
      // Prevent listener errors from impacting execution
    }
  }

  return summary
}

export function subscribe(listener: (summary: TraceSummary) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function get(sessionID: string): TraceState | undefined {
  if (!isEnabled()) return undefined
  return activeTraces.get(sessionID) ?? completedTraces.get(sessionID)
}

export function reset(): void {
  activeTraces.clear()
  completedTraces.clear()
  listeners.clear()
}
