import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = (...parts: string[]) => readFileSync(join(import.meta.dir, ...parts), "utf8")

describe("BharatCode shared UI branding", () => {
  test("does not expose OpenCode names or links in user-facing UI assets", () => {
    const files = [
      src("context", "marked.tsx"),
      src("pierre", "index.ts"),
      src("pierre", "worker.ts"),
      src("theme", "context.tsx"),
      src("theme", "desktop-theme.schema.json"),
      src("theme", "themes", "opencode.json"),
      src("assets", "favicon", "site.webmanifest"),
      src("components", "font.stories.tsx"),
      src("components", "icon.stories.tsx"),
      src("v2", "components", "avatar-v2.stories.tsx"),
      src("v2", "components", "line-comment-v2.stories.tsx"),
      src("v2", "components", "tool-error-card-v2.tsx"),
      src("v2", "components", "tool-error-card-v2.stories.tsx"),
      src("i18n", "en.ts"),
    ].join("\n")

    expect(files).not.toContain("OpenCode")
    expect(files).not.toContain("opencode.ai")
    expect(files).toContain("BharatCode")
  })
})
