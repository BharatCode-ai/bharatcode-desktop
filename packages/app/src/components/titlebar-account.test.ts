import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { titlebarAccountView } from "./titlebar-account-button"

describe("shared titlebar account affordance", () => {
  test("covers loading, online, offline, expired, switching, and logged-out states", () => {
    expect(titlebarAccountView()).toEqual({ state: "checking", tone: "muted", action: "none" })
    expect(titlebarAccountView({ state: "signed_in" })).toEqual({
      state: "signed_in",
      tone: "success",
      action: "open",
    })
    expect(titlebarAccountView({ state: "connection_issue" })).toEqual({
      state: "connection_issue",
      tone: "danger",
      action: "refresh",
    })
    expect(titlebarAccountView({ state: "needs_sign_in" })).toEqual({
      state: "needs_sign_in",
      tone: "warning",
      action: "sign_in",
    })
    expect(titlebarAccountView({ state: "switching" })).toEqual({
      state: "switching",
      tone: "muted",
      action: "none",
    })
    expect(titlebarAccountView({ state: "signed_out" })).toEqual({
      state: "signed_out",
      tone: "muted",
      action: "sign_in",
    })
  })

  test("composes the same component in legacy and v2 titlebar branches", async () => {
    const source = await readFile(join(import.meta.dir, "titlebar.tsx"), "utf8")
    expect(source).toContain('accountButton("v2")')
    expect(source).toContain('accountButton("legacy")')
    expect(source.match(/<TitlebarAccountButton/g)).toHaveLength(1)
    expect(source).not.toContain('id: "provider.connect"')
  })
})
