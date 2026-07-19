import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

describe("shipped ShareNext-disabled UI", () => {
  test("has no share command, mutation, snapshot serialization, or share URL action", async () => {
    const sources = await Promise.all(
      ["use-session-commands.tsx", "message-timeline.tsx"].map((file) => readFile(join(import.meta.dir, file), "utf8")),
    )
    const shipped = sources.join("\n")
    expect(shipped).not.toMatch(/session\.(?:share|unshare)\s*\(/)
    expect(shipped).not.toMatch(/id:\s*"session\.(?:share|unshare)"/)
    expect(shipped).not.toMatch(/shareMutation|unshareMutation|shareSession|unshareSession/)
    expect(shipped).not.toMatch(/Snapshot|snapshot.*serializ/i)

    const sessionHeader = await readFile(
      join(import.meta.dir, "..", "..", "components", "session", "session-header.tsx"),
      "utf8",
    )
    expect(sessionHeader).toContain('language.t("session.share.copy.copied")')
    expect(sessionHeader).not.toMatch(/client\.session\.(?:share|unshare)|shareMutation|unshareMutation/)
  })
})
