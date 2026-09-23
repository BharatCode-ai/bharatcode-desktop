import { expect, test } from "bun:test"
import { ToolLoopGuard } from "../src/session/tool-loop-guard"

test("counts identical failed inputs regardless of object key order without exposing values", () => {
  const failures = [
    { tool: "bash", input: { command: "private-token", nested: { b: 2, a: 1 } }, error: "private-error" },
    { tool: "bash", input: { nested: { a: 1, b: 2 }, command: "private-token" }, error: "another-secret" },
    { tool: "bash", input: { command: "private-token", nested: { a: 1, b: 2 } }, error: "private-error" },
  ]
  const result = ToolLoopGuard.repeatedFailure(failures, "bash", failures[0].input)
  expect(result).toMatchObject({ tool: "bash", count: 3, threshold: 3 })
  expect(result?.errorFingerprints).toHaveLength(2)
  expect(JSON.stringify(result)).not.toMatch(/private-token|private-error|another-secret/)
  expect(ToolLoopGuard.message(result!)).toContain("different approach")
  expect(ToolLoopGuard.repeatedFailure(failures, "read", failures[0].input)).toBeUndefined()
  expect(ToolLoopGuard.repeatedFailure(failures, "bash", { command: "different" })).toBeUndefined()
  expect(ToolLoopGuard.repeatedFailure(failures.slice(0, 2), "bash", failures[0].input)).toBeUndefined()
})

test("arrays retain order and unencodable input cannot become a shared failure identity", () => {
  expect(ToolLoopGuard.inputFingerprint({ a: [1, 2] })).not.toBe(ToolLoopGuard.inputFingerprint({ a: [2, 1] }))
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(ToolLoopGuard.inputFingerprint(cyclic)).toBeUndefined()
  expect(
    ToolLoopGuard.repeatedFailure(
      Array.from({ length: 3 }, () => ({ tool: "x", input: cyclic, error: "fail" })),
      "x",
      cyclic,
    ),
  ).toBeUndefined()
})
