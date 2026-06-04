import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = (...parts: string[]) => readFileSync(join(import.meta.dir, ...parts), "utf8")

describe("BharatCode logo components", () => {
  test("ship BharatCode branded marks and wordmarks", () => {
    const files = [src("logo.tsx"), src("..", "v2", "components", "wordmark-v2.tsx")].join("\n")

    expect(files).toContain("BharatCode")
    expect(files).toContain("#ff6b35")
    expect(files).not.toContain("logo-mark-b")
    expect(files).not.toContain("BHARATCODE")
  })
})
