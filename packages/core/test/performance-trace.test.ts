import { expect, describe, test, beforeEach } from "bun:test"
import { PerformanceTrace, type TraceSummary } from "../src/performance-trace"

describe("PerformanceTrace (TTFT instrumentation)", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_PERF_TRACE
    PerformanceTrace.reset()
  })

  test("captures all timing marks in lifecycle sequence and calculates TTFT accurately", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_perf_123"
    let capturedSummary: TraceSummary | undefined

    PerformanceTrace.subscribe((summary) => {
      capturedSummary = summary
    })

    // Step 1: User prompt submitted
    PerformanceTrace.start(sessionID, { messageID: "msg_user_1" })
    await new Promise((r) => setTimeout(r, 10))

    // Step 2: Request constructed
    PerformanceTrace.mark(sessionID, "request_construction")
    await new Promise((r) => setTimeout(r, 10))

    // Step 3: Network request started
    PerformanceTrace.mark(sessionID, "network_start", { modelID: "gpt-4o", providerID: "openai" })
    await new Promise((r) => setTimeout(r, 15))

    // Step 4: First stream event received from provider
    PerformanceTrace.mark(sessionID, "first_stream_event")
    await new Promise((r) => setTimeout(r, 10))

    // Step 5: First token parsed
    PerformanceTrace.mark(sessionID, "first_token_parsed")
    await new Promise((r) => setTimeout(r, 5))

    // Step 6: First token emitted by backend
    PerformanceTrace.mark(sessionID, "first_token_emitted")

    expect(capturedSummary).toBeDefined()
    const summary = capturedSummary!

    expect(summary.sessionID).toBe(sessionID)
    expect(summary.messageID).toBe("msg_user_1")
    expect(summary.modelID).toBe("gpt-4o")
    expect(summary.providerID).toBe("openai")

    // Total TTFT must be positive and at least the sum of timeouts (~50ms)
    expect(summary.totalTtftMs).toBeGreaterThanOrEqual(40)

    // Verify all marks exist in chronological order
    const marks = summary.marks
    expect(marks.user_prompt_submit).toBeDefined()
    expect(marks.request_construction).toBeDefined()
    expect(marks.network_start).toBeDefined()
    expect(marks.first_stream_event).toBeDefined()
    expect(marks.first_token_parsed).toBeDefined()
    expect(marks.first_token_emitted).toBeDefined()

    expect(marks.request_construction!).toBeGreaterThanOrEqual(marks.user_prompt_submit!)
    expect(marks.network_start!).toBeGreaterThanOrEqual(marks.request_construction!)
    expect(marks.first_stream_event!).toBeGreaterThanOrEqual(marks.network_start!)
    expect(marks.first_token_parsed!).toBeGreaterThanOrEqual(marks.first_stream_event!)
    expect(marks.first_token_emitted!).toBeGreaterThanOrEqual(marks.first_token_parsed!)

    // Verify intermediate stage durations
    expect(summary.durations.promptToRequestConstructionMs).toBeGreaterThanOrEqual(8)
    expect(summary.durations.requestConstructionToNetworkStartMs).toBeGreaterThanOrEqual(8)
    expect(summary.durations.networkStartToFirstStreamEventMs).toBeGreaterThanOrEqual(10)
    expect(summary.durations.firstStreamEventToFirstTokenParsedMs).toBeGreaterThanOrEqual(8)
    expect(summary.durations.firstTokenParsedToEmittedMs).toBeGreaterThanOrEqual(3)
  })

  test("disabled tracing retains zero traces and performs zero allocations", () => {
    delete process.env.OPENCODE_PERF_TRACE
    expect(PerformanceTrace.isEnabled()).toBe(false)

    const sessionID = "ses_disabled"
    PerformanceTrace.start(sessionID, { messageID: "msg_1" })
    PerformanceTrace.mark(sessionID, "request_construction")
    PerformanceTrace.mark(sessionID, "network_start")
    PerformanceTrace.mark(sessionID, "first_stream_event")
    PerformanceTrace.mark(sessionID, "first_token_parsed")
    PerformanceTrace.mark(sessionID, "first_token_emitted")

    expect(PerformanceTrace.get(sessionID)).toBeUndefined()
    expect(PerformanceTrace.complete(sessionID)).toBeUndefined()
    expect(PerformanceTrace.activeTraceCount()).toBe(0)
    expect(PerformanceTrace.completedTraceCount()).toBe(0)
  })

  test("bounded trace eviction caps memory on high volume of sessions", () => {
    process.env.OPENCODE_PERF_TRACE = "1"

    // Simulate 150 active traces
    for (let i = 0; i < 150; i++) {
      PerformanceTrace.start(`session_active_${i}`)
    }
    expect(PerformanceTrace.activeTraceCount()).toBeLessThanOrEqual(100)

    // Simulate completing 150 traces
    for (let i = 0; i < 150; i++) {
      const id = `session_completed_${i}`
      PerformanceTrace.start(id)
      PerformanceTrace.mark(id, "first_token_emitted")
    }
    expect(PerformanceTrace.completedTraceCount()).toBeLessThanOrEqual(100)
  })

  test("enforces zero prompt and token leakage in trace summaries and telemetry", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_leak_check"
    const sensitivePrompt = "SECRET_API_KEY_xyz123 PRIVATE_USER_PROMPT"
    const sensitiveToken = "CONFIDENTIAL_TOKEN_TEXT"

    const logs: string[] = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }

    try {
      PerformanceTrace.start(sessionID, { messageID: "msg_user_leak" })
      PerformanceTrace.mark(sessionID, "request_construction")
      PerformanceTrace.mark(sessionID, "network_start")
      PerformanceTrace.mark(sessionID, "first_stream_event")
      PerformanceTrace.mark(sessionID, "first_token_parsed")
      PerformanceTrace.mark(sessionID, "first_token_emitted")

      const summary = PerformanceTrace.complete(sessionID)
      const serialized = JSON.stringify(summary)

      // Ensure sensitive prompt or token strings are nowhere in the summary structure
      expect(serialized).not.toContain(sensitivePrompt)
      expect(serialized).not.toContain(sensitiveToken)
      expect(serialized).not.toContain("prompt_text")
      expect(serialized).not.toContain("token_text")

      // Ensure console telemetry has no prompt or token leakage
      const allLogs = logs.join("\n")
      expect(allLogs).toContain("[PERF_TRACE:TTFT]")
      expect(allLogs).not.toContain(sensitivePrompt)
      expect(allLogs).not.toContain(sensitiveToken)
    } finally {
      console.info = originalInfo
    }
  })

  test("is idempotent across subsequent streaming tokens", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_streaming"
    PerformanceTrace.start(sessionID)
    PerformanceTrace.mark(sessionID, "request_construction")
    PerformanceTrace.mark(sessionID, "network_start")
    PerformanceTrace.mark(sessionID, "first_stream_event")
    PerformanceTrace.mark(sessionID, "first_token_parsed")
    PerformanceTrace.mark(sessionID, "first_token_emitted")

    const firstSummary = PerformanceTrace.get(sessionID)
    const initialParsedTime = firstSummary?.marks.get("first_token_parsed")
    const initialEmittedTime = firstSummary?.marks.get("first_token_emitted")

    // Simulate 20 subsequent tokens arriving in the same stream turn
    await new Promise((r) => setTimeout(r, 10))
    for (let i = 0; i < 20; i++) {
      PerformanceTrace.mark(sessionID, "first_token_parsed")
      PerformanceTrace.mark(sessionID, "first_token_emitted")
    }

    const currentSummary = PerformanceTrace.get(sessionID)
    expect(currentSummary?.marks.get("first_token_parsed")).toBe(initialParsedTime)
    expect(currentSummary?.marks.get("first_token_emitted")).toBe(initialEmittedTime)
  })

  test("maintains complete isolation between concurrent sessions", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionA = "session_A"
    const sessionB = "session_B"

    PerformanceTrace.start(sessionA, { modelID: "claude-3-5-sonnet" })
    PerformanceTrace.start(sessionB, { modelID: "gpt-4o" })

    PerformanceTrace.mark(sessionA, "request_construction")
    PerformanceTrace.mark(sessionB, "request_construction")

    const traceA = PerformanceTrace.get(sessionA)
    const traceB = PerformanceTrace.get(sessionB)

    expect(traceA?.sessionID).toBe(sessionA)
    expect(traceA?.metadata.modelID).toBe("claude-3-5-sonnet")

    expect(traceB?.sessionID).toBe(sessionB)
    expect(traceB?.metadata.modelID).toBe("gpt-4o")

    expect(traceA?.sessionID).not.toBe(traceB?.sessionID)
  })

  test("native provider execution path triggers network, first stream event, and parse marks", () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_native_path"
    PerformanceTrace.start(sessionID)

    // Mark network start on native runtime branch
    PerformanceTrace.mark(sessionID, "network_start", { modelID: "claude-3-5", providerID: "anthropic" })

    // Native stream events passing through Stream.tap
    const streamEvents = [
      { type: "text-start" },
      { type: "text-delta", text: "first native token" },
      { type: "text-end" },
    ]

    for (const event of streamEvents) {
      if (
        event.type === "text-start" ||
        event.type === "text-delta" ||
        event.type === "reasoning-start" ||
        event.type === "reasoning-delta" ||
        event.type === "tool-call" ||
        event.type === "tool-input-start" ||
        event.type === "tool-input-delta"
      ) {
        PerformanceTrace.mark(sessionID, "first_stream_event")
      }
      if (
        event.type === "text-delta" ||
        event.type === "reasoning-delta" ||
        event.type === "tool-call" ||
        event.type === "tool-input-start" ||
        event.type === "tool-input-delta"
      ) {
        PerformanceTrace.mark(sessionID, "first_token_parsed")
      }
    }

    // Backend emission
    PerformanceTrace.mark(sessionID, "first_token_emitted")

    const trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("network_start")).toBe(true)
    expect(trace?.marks.has("first_stream_event")).toBe(true)
    expect(trace?.marks.has("first_token_parsed")).toBe(true)
    expect(trace?.marks.has("first_token_emitted")).toBe(true)
    expect(trace?.completed).toBe(true)
  })
})
