import { describe, expect, test } from "bun:test"

import { syncDirectory } from "@/migration/durability"

describe("migration durability", () => {
  test("does not attempt unsupported directory fsync on Windows", async () => {
    await expect(syncDirectory("Z:\\path-that-must-not-be-opened", "win32")).resolves.toBeUndefined()
  })
})
