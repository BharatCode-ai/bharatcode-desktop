import { expect, test } from "bun:test"
import { releaseIdentity } from "./release"

test("release identity is local and branded, never inferred from the upstream registry or a branch name", () => {
  expect(releaseIdentity("1.15.35", {})).toEqual({ channel: "dev", version: "1.15.35", preview: true })
  expect(releaseIdentity("1.15.35", { BHARATCODE_CHANNEL: "beta" })).toEqual({
    channel: "beta",
    version: "1.15.35",
    preview: true,
  })
  expect(releaseIdentity("1.15.35", { OPENCODE_CHANNEL: "latest" })).toEqual({
    channel: "prod",
    version: "1.15.35",
    preview: false,
  })
  expect(releaseIdentity("1.15.35", { BHARATCODE_VERSION: "1.15.36", OPENCODE_VERSION: "99.0.0" }).version).toBe(
    "1.15.36",
  )
  expect(releaseIdentity("1.15.35", { OPENCODE_BUMP: "patch" }).version).toBe("1.15.36")
  expect(() => releaseIdentity("1.15.35", { OPENCODE_CHANNEL: "chore/something" })).toThrow("channel")
  expect(() => releaseIdentity("1.15.35", { OPENCODE_VERSION: "bad'input" })).toThrow("version")
})
