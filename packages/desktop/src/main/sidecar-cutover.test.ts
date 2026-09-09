import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

describe("Desktop shared-runtime cutover", () => {
  test("uses only branded sidecar credentials and never sends them to preload or renderer", async () => {
    const [sidecar, server, main, ipc, preload, types, renderer] = await Promise.all([
      readFile(join(import.meta.dir, "sidecar.ts"), "utf8"),
      readFile(join(import.meta.dir, "server.ts"), "utf8"),
      readFile(join(import.meta.dir, "index.ts"), "utf8"),
      readFile(join(import.meta.dir, "ipc.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "preload", "index.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "preload", "types.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "renderer", "index.tsx"), "utf8"),
    ])

    expect(sidecar).toContain("BHARATCODE_SERVER_USERNAME")
    expect(sidecar).toContain("BHARATCODE_SERVER_PASSWORD")
    expect(sidecar).not.toMatch(/process\.env\.OPENCODE_SERVER_(?:USERNAME|PASSWORD)\s*=/)
    expect(server).toContain('env.BHARATCODE_SERVER_USERNAME = "bharatcode"')
    expect(server).toContain("env.BHARATCODE_SERVER_PASSWORD = password")
    expect(`${main}\n${ipc}\n${preload}\n${types}\n${renderer}`).not.toMatch(
      /ServerReadyData[^}]+(?:username|password)|data\.(?:username|password)|serverReady[^}]+(?:username|password)/s,
    )
  })

  test("rejects any defined legacy server-auth environment before listen", async () => {
    const [source, server, auth] = await Promise.all([
      readFile(join(import.meta.dir, "sidecar.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "..", "..", "opencode", "src", "server", "server.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "..", "..", "opencode", "src", "server", "auth.ts"), "utf8"),
    ])
    expect(server).toContain("ServerAuth.rejectLegacyEnvironment(process.env)")
    expect(server.indexOf("ServerAuth.rejectLegacyEnvironment(process.env)")).toBeLessThan(
      server.indexOf("Effect.runPromise(listenEffect(opts))"),
    )
    expect(auth).toContain('"OPENCODE_SERVER_USERNAME" in environment')
    expect(auth).toContain('"OPENCODE_SERVER_PASSWORD" in environment')
    expect(`${source}\n${server}\n${auth}`).not.toMatch(
      /legacy[^\n]+\$\{|OPENCODE_SERVER_(?:USERNAME|PASSWORD).*value/i,
    )
  })

  test("public Desktop account IPC is action-only and secret-free", async () => {
    const [ipc, preload, types] = await Promise.all([
      readFile(join(import.meta.dir, "ipc.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "preload", "index.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", "preload", "types.ts"), "utf8"),
    ])
    const serialized = `${ipc}\n${preload}\n${types}`
    for (const operation of [
      "get-account-status",
      "begin-sign-in",
      "complete-sign-in",
      "logout",
      "refresh-account-status",
    ])
      expect(serialized).toContain(operation)
    expect(serialized).not.toMatch(/refresh_token|access_token|credentialsPath|configPath/i)
  })
})
