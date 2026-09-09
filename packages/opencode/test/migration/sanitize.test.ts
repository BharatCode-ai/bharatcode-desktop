import { describe, expect, test } from "bun:test"

import { sanitizeMigrationRecord } from "@/migration/sanitize"

describe("migration sanitation", () => {
  test("projects allowlisted configuration and reports discarded active paths", () => {
    const result = sanitizeMigrationRecord({
      kind: "config",
      value: {
        theme: "bharatcode",
        language: "en",
        keybinds: { leader: "ctrl+x" },
        $schema: "https://opencode.ai/config.json",
        provider: { opencode: { apiKey: "sk-secret-value" } },
        model: "opencode/coder",
        plugin: ["https://opncd.ai/plugin.js"],
        mcp: { remote: { url: "https://models.dev/mcp" } },
        command: ["opencode", "serve"],
        update: { url: "https://opencode.ai/update" },
      },
    })

    expect(result.value).toEqual({ theme: "bharatcode", language: "en", keybinds: { leader: "ctrl+x" } })
    expect(result.discardedPaths).toEqual([
      "$schema",
      "command",
      "mcp",
      "model",
      "plugin",
      "provider",
      "update",
    ])
    expect(JSON.stringify(result)).not.toMatch(/opencode\.ai|opncd\.ai|models\.dev|sk-secret/i)
  })

  test("retains eligible session and project text without activating mentioned identities", () => {
    const session = sanitizeMigrationRecord({
      kind: "session",
      value: {
        id: "ses_1",
        title: "Keep this chat about opencode.ai",
        time: { created: 1, updated: 2 },
        messages: [{ id: "msg_1", role: "user", text: "Do not visit https://opencode.ai" }],
        provider: "opencode",
        tool: { command: ["opencode", "run"] },
      },
    })
    const project = sanitizeMigrationRecord({
      kind: "project",
      value: { id: "prj_1", worktree: "/home/alice/opencode-notes", name: "Local notes", command: "opencode" },
    })

    expect(session.value).toMatchObject({ title: "Keep this chat about opencode.ai" })
    expect(session.discardedPaths).toEqual(["provider", "tool"])
    expect(project.value).toEqual({ id: "prj_1", worktree: "/home/alice/opencode-notes", name: "Local notes" })
    expect(project.discardedPaths).toEqual(["command"])
  })

  test.each([
    ["tui" as const, { theme: "dark", keybinds: { quit: "ctrl+q" }, command: "opencode" }],
    ["desktop" as const, { theme: "system", language: "hi", serverUrl: "https://opencode.ai" }],
  ])("sanitizes %s records through a closed allowlist", (kind, value) => {
    const result = sanitizeMigrationRecord({ kind, value })
    expect(result.kind).toBe(kind)
    expect(JSON.stringify(result.value)).not.toMatch(/opencode\.ai|command/i)
    expect(result.discardedPaths).toHaveLength(1)
  })

  test("rejects malformed records and credential-shaped retained values", () => {
    expect(() => sanitizeMigrationRecord({ kind: "config", value: [] })).toThrow("record")
    expect(() => sanitizeMigrationRecord({ kind: "config", value: { theme: "Bearer eyJabcdefghijklmnop" } })).toThrow(
      "credential",
    )
    expect(() =>
      sanitizeMigrationRecord({ kind: "project", value: { id: "prj_1", worktree: "relative/project" } }),
    ).toThrow("absolute")
  })
})
