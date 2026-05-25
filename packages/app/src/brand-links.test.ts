import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = (...parts: string[]) => readFileSync(join(import.meta.dir, ...parts), "utf8")

describe("BharatCode app UI branding", () => {
  test("does not send visible app help or notifications to opencode.ai", () => {
    const files = [
      src("entry.tsx"),
      src("pages", "home.tsx"),
      src("pages", "error.tsx"),
      src("pages", "layout.tsx"),
      src("pages", "layout", "helpers.ts"),
      src("components", "dialog-connect-provider.tsx"),
    ].join("\n")

    expect(files).not.toContain("https://opencode.ai")
    expect(files).toContain("https://bharatcode.ai")
  })
})
