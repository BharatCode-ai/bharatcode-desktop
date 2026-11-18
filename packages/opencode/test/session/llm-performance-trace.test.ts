import { describe, expect, test, beforeEach } from "bun:test"
import { Effect, Exit } from "effect"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"
import { PerformanceTrace } from "@opencode-ai/core/performance-trace"

describe("session.llm.ai-sdk performance trace instrumentation", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_PERF_TRACE
    PerformanceTrace.reset()
  })

  test("real adapter records first_stream_event and first_token_parsed across delayed chunks", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_delayed_stream"
    PerformanceTrace.start(sessionID)
    PerformanceTrace.mark(sessionID, "network_start")

    const state = LLMAISDK.adapterState(sessionID)
    const adapt = (event: Parameters<typeof LLMAISDK.toLLMEvents>[1]) =>
      Effect.runPromise(LLMAISDK.toLLMEvents(state, event))

    await new Promise((r) => setTimeout(r, 15))

    // Real first stream event (content start)
    await adapt({ type: "text-start", id: "text-1" })
    let trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(true)
    expect(trace?.marks.has("first_token_parsed")).toBe(false)
    const streamEventTime = trace?.marks.get("first_stream_event")

    await new Promise((r) => setTimeout(r, 15))

    // Real first token parsed (text delta)
    await adapt({ type: "text-delta", id: "text-1", text: "Hello" })
    trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_token_parsed")).toBe(true)
    const tokenParsedTime = trace?.marks.get("first_token_parsed")

    expect(tokenParsedTime!).toBeGreaterThanOrEqual(streamEventTime!)
    expect(streamEventTime!).toBeGreaterThanOrEqual(trace?.marks.get("network_start")!)

    // Subsequent stream deltas do not overwrite marks
    await new Promise((r) => setTimeout(r, 10))
    await adapt({ type: "text-delta", id: "text-1", text: " world" })
    trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.get("first_stream_event")).toBe(streamEventTime)
    expect(trace?.marks.get("first_token_parsed")).toBe(tokenParsedTime)
  })

  test("synthetic lifecycle events (start, start-step, finish-step, finish) do NOT mark stream events", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_synthetic_lifecycle"
    PerformanceTrace.start(sessionID)

    const state = LLMAISDK.adapterState(sessionID)
    const adapt = (event: Parameters<typeof LLMAISDK.toLLMEvents>[1]) =>
      Effect.runPromise(LLMAISDK.toLLMEvents(state, event))

    // 1. Synthetic start
    await adapt({ type: "start" })
    let trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(false)
    expect(trace?.marks.has("first_token_parsed")).toBe(false)

    // 2. Synthetic start-step
    await adapt({ type: "start-step", request: {}, warnings: [] })
    trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(false)
    expect(trace?.marks.has("first_token_parsed")).toBe(false)

    // 3. Synthetic finish-step
    await adapt({
      type: "finish-step",
      response: { id: "res-1", timestamp: new Date(0), modelId: "test-model" },
      finishReason: "stop",
      rawFinishReason: "stop",
      providerMetadata: undefined,
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      },
    })
    trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(false)
    expect(trace?.marks.has("first_token_parsed")).toBe(false)

    // 4. Synthetic finish
    await adapt({
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      },
    })
    trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(false)
    expect(trace?.marks.has("first_token_parsed")).toBe(false)
  })

  test("stream error event does NOT mark stream events or complete the trace", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_stream_error"
    PerformanceTrace.start(sessionID)

    const state = LLMAISDK.adapterState(sessionID)
    const exit = await Effect.runPromiseExit(
      LLMAISDK.toLLMEvents(state, {
        type: "error",
        error: new Error("Connection reset by peer"),
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)

    const trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(false)
    expect(trace?.marks.has("first_token_parsed")).toBe(false)
    expect(trace?.completed).toBe(false)
  })

  test("tool-only turn with streaming tool input marks first_stream_event and first_token_parsed", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_tool_only_stream"
    PerformanceTrace.start(sessionID)
    PerformanceTrace.mark(sessionID, "network_start")

    const state = LLMAISDK.adapterState(sessionID)
    const adapt = (event: Parameters<typeof LLMAISDK.toLLMEvents>[1]) =>
      Effect.runPromise(LLMAISDK.toLLMEvents(state, event))

    // Initial synthetic start-step
    await adapt({ type: "start-step", request: {}, warnings: [] })
    expect(PerformanceTrace.get(sessionID)?.marks.has("first_stream_event")).toBe(false)

    // Streaming tool input starts
    await adapt({ type: "tool-input-start", id: "call_abc123", toolName: "read_file" })
    let trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(true)
    expect(trace?.marks.has("first_token_parsed")).toBe(true)

    // Streaming deltas
    await adapt({ type: "tool-input-delta", id: "call_abc123", delta: '{"path":' })
    await adapt({ type: "tool-input-delta", id: "call_abc123", delta: '"foo.ts"}' })
    await adapt({ type: "tool-input-end", id: "call_abc123" })

    // Backend emits the tool part
    PerformanceTrace.mark(sessionID, "first_token_emitted")

    const summary = PerformanceTrace.complete(sessionID)
    expect(summary).toBeDefined()
    expect(summary?.marks.first_stream_event).toBeDefined()
    expect(summary?.marks.first_token_parsed).toBeDefined()
    expect(summary?.marks.first_token_emitted).toBeDefined()
    expect(summary?.durations.firstStreamEventToFirstTokenParsedMs).toBeDefined()
    expect(summary?.durations.firstTokenParsedToEmittedMs).toBeDefined()
  })

  test("tool-only turn with direct tool-call event marks first_stream_event and first_token_parsed", async () => {
    process.env.OPENCODE_PERF_TRACE = "1"
    const sessionID = "ses_tool_direct"
    PerformanceTrace.start(sessionID)
    PerformanceTrace.mark(sessionID, "network_start")

    const state = LLMAISDK.adapterState(sessionID)
    await Effect.runPromise(
      LLMAISDK.toLLMEvents(state, {
        type: "tool-call",
        toolCallId: "call_xyz789",
        toolName: "list_directory",
        input: { path: "src" },
      }),
    )

    const trace = PerformanceTrace.get(sessionID)
    expect(trace?.marks.has("first_stream_event")).toBe(true)
    expect(trace?.marks.has("first_token_parsed")).toBe(true)

    PerformanceTrace.mark(sessionID, "first_token_emitted")
    expect(trace?.completed).toBe(true)
  })

  test("disabled tracing with real adapter creates zero traces", async () => {
    delete process.env.OPENCODE_PERF_TRACE
    const sessionID = "ses_disabled_real_adapter"

    const state = LLMAISDK.adapterState(sessionID)
    await Effect.runPromise(
      LLMAISDK.toLLMEvents(state, {
        type: "text-start",
        id: "text-1",
      }),
    )
    await Effect.runPromise(
      LLMAISDK.toLLMEvents(state, {
        type: "text-delta",
        id: "text-1",
        text: "hello",
      }),
    )

    expect(PerformanceTrace.get(sessionID)).toBeUndefined()
  })
})
