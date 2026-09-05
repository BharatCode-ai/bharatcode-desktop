// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run --attach ...`
// against its isolated protocol fixture.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { raw } from "../../lib/llm-server"

describe("opencode run (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "delivers the complete subscription denial in structured output and exits nonzero",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const message =
          "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."
        yield* llm.fail(message)
        const result = yield* opencode.run("Reply only OK. Do not use tools.", { format: "json" })
        expect(result.exitCode).not.toBe(0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.some((event) => event.type === "error" && JSON.stringify(event.error).includes(message))).toBe(
          true,
        )
        expect(events.some((event) => event.type === "text")).toBe(false)
      }),
    60_000,
  )
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
      }),
    60_000,
  )

  cliIt.concurrent(
    "waits for delayed assistant output before exiting",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.hold("delayed plain output", Bun.sleep(250))
        const result = yield* opencode.run("wait for the delayed response")
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("delayed plain output")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", {
          model: "bharatcode/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  cliIt.concurrent(
    "exits nonzero when the accepted prompt fails mid-stream",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* opencode.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  cliIt.concurrent(
    "exits nonzero when the accepted prompt stream closes before idle",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(raw({ reset: true }))
        const result = yield* opencode.run("close the stream before idle", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("event stream closed before the session became idle")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(result, 0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        // At least one `text` event should appear with the LLM's response.
        const text = events.find((e) => e.type === "text")
        expect(text).toBeDefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json waits for delayed terminal events",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.hold("delayed structured output", Bun.sleep(250))
        const result = yield* opencode.run("wait for structured output", { format: "json" })
        opencode.expectExit(result, 0)
        expect(opencode.parseJsonEvents(result.stdout).some((event) => event.type === "text")).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "drains a response larger than the stdout high-water mark before exiting",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const text = "bharatcode-output-drain-".repeat(16_384)
        yield* llm.text(text)
        const result = yield* opencode.run("write the complete response")
        opencode.expectExit(result, 0)
        expect(result.stdout.trim()).toBe(text)
      }),
    60_000,
  )
})
