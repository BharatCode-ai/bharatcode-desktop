import { expect, test } from "bun:test"
import * as Guard from "../src/session/tool-loop-guard"

test("counts identical failed inputs regardless of object key order without exposing values", () => {
  const failures = [
    { tool: "bash", input: { command: "private-token", nested: { b: 2, a: 1 } }, error: "private-error" },
    { tool: "bash", input: { nested: { a: 1, b: 2 }, command: "private-token" }, error: "another-secret" },
    { tool: "bash", input: { command: "private-token", nested: { a: 1, b: 2 } }, error: "private-error" },
  ]
  const result = Guard.repeatedFailure(failures, "bash", failures[0].input)
  expect(result).toMatchObject({ tool: "bash", count: 3, threshold: 3 })
  expect(result?.errorFingerprints).toHaveLength(2)
  expect(JSON.stringify(result)).not.toMatch(/private-token|private-error|another-secret/)
  expect(Guard.message(result!)).toContain("different approach")
  expect(Guard.repeatedFailure(failures, "read", failures[0].input)).toBeUndefined()
  expect(Guard.repeatedFailure(failures, "bash", { command: "different" })).toBeUndefined()
  expect(Guard.repeatedFailure(failures.slice(0, 2), "bash", failures[0].input)).toBeUndefined()
})

test("arrays retain order and unencodable input cannot become a shared failure identity", () => {
  expect(Guard.inputFingerprint({ a: [1, 2] })).not.toBe(Guard.inputFingerprint({ a: [2, 1] }))
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(Guard.inputFingerprint(cyclic)).toBeUndefined()
  expect(
    Guard.repeatedFailure(
      Array.from({ length: 3 }, () => ({ tool: "x", input: cyclic, error: "fail" })),
      "x",
      cyclic,
    ),
  ).toBeUndefined()
})
