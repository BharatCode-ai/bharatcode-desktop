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

  test("keeps share surfaces visible only when configured and avoids raw share failure logging", () => {
    const files = [
      src("i18n", "en.ts"),
      src("pages", "session", "message-timeline.tsx"),
      src("pages", "session", "use-session-commands.tsx"),
    ].join("\n")

    expect(files).toContain("BharatCode could not share this session")
    expect(files).toContain('sync.data.config.share !== "disabled"')
    expect(files).toContain('sync.data.config.share === "disabled"')
    expect(files).toContain('slash: "share"')
    expect(files).toContain('slash: "unshare"')
    expect(files).toContain('console.error("BharatCode share failed")')
    expect(files).toContain('console.error("BharatCode unshare failed")')
    expect(files).not.toContain('console.error("Failed to share session", err)')
    expect(files).not.toContain('console.error("Failed to unshare session", err)')
  })
})
