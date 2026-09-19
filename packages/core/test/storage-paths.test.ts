import { describe, expect, test } from "bun:test"
import path from "node:path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

describe("BharatCode storage paths", () => {
  test("resolves stable and beta Linux stores without OpenCode identity", () => {
    const stable = StoragePaths.resolve({
      channel: "latest",
      platform: "linux",
      home: "/home/alice",
      temp: "/tmp",
      env: {},
    })
    const beta = StoragePaths.resolve({
      channel: "beta",
      platform: "linux",
      home: "/home/alice",
      temp: "/tmp",
      env: {},
    })

    expect(stable).toEqual({
      channel: "prod",
      data: "/home/alice/.local/share/bharatcode",
      cache: "/home/alice/.cache/bharatcode",
      config: "/home/alice/.config/bharatcode",
      state: "/home/alice/.local/state/bharatcode",
      recovery: "/home/alice/.local/state/bharatcode",
      tmp: "/tmp/bharatcode",
      bin: "/home/alice/.cache/bharatcode/bin",
      log: "/home/alice/.local/state/bharatcode/log",
      repos: "/home/alice/.local/share/bharatcode/repos",
      storage: "/home/alice/.local/share/bharatcode/storage",
      auth: "/home/alice/.local/share/bharatcode/auth.json",
      database: "/home/alice/.local/share/bharatcode/bharatcode.db",
    })
    expect(beta.data).toBe("/home/alice/.local/share/bharatcode-beta")
    expect(beta.auth).toBe("/home/alice/.local/share/bharatcode-beta/auth.json")
    expect(beta.database).toBe("/home/alice/.local/share/bharatcode-beta/bharatcode.db")
    expect(Object.values(stable).join("\n").toLowerCase()).not.toContain("opencode")
    expect(Object.values(beta).join("\n").toLowerCase()).not.toContain("opencode")
  })

  test("resolves canonical macOS and Windows stores", () => {
    expect(
      StoragePaths.resolve({
        channel: "prod",
        platform: "darwin",
        home: "/Users/Alice",
        temp: "/private/tmp",
        env: {},
      }),
    ).toMatchObject({
      data: "/Users/Alice/Library/Application Support/bharatcode",
      config: "/Users/Alice/Library/Preferences/bharatcode",
      cache: "/Users/Alice/Library/Caches/bharatcode",
      state: "/Users/Alice/Library/Application Support/bharatcode/State",
      recovery: "/Users/Alice/Library/Application Support/bharatcode-recovery",
      log: "/Users/Alice/Library/Logs/bharatcode",
      auth: "/Users/Alice/Library/Application Support/bharatcode/auth.json",
    })
    expect(
      StoragePaths.resolve({
        channel: "next",
        platform: "win32",
        home: "C:\\Users\\Alice",
        temp: "C:\\Temp",
        env: { APPDATA: "D:\\Roaming", LOCALAPPDATA: "D:\\Local" },
      }),
    ).toMatchObject({
      channel: "beta",
      data: "D:\\Local\\bharatcode-beta\\Data",
      config: "D:\\Roaming\\bharatcode-beta\\Config",
      cache: "D:\\Local\\bharatcode-beta\\Cache",
      recovery: "D:\\Local\\bharatcode-beta\\State",
      auth: "D:\\Local\\bharatcode-beta\\Data\\auth.json",
      database: "D:\\Local\\bharatcode-beta\\Data\\bharatcode.db",
    })
  })

  test("keeps the macOS migration transaction root disjoint from every destination role", () => {
    const paths = StoragePaths.resolve({
      channel: "beta",
      platform: "darwin",
      home: "/Users/Alice",
      temp: "/private/tmp",
      env: {},
    })
    const roots = [paths.data, paths.config, paths.recovery]

    for (const [index, left] of roots.entries()) {
      for (const right of roots.slice(index + 1)) {
        expect(path.relative(left, right).startsWith("..")).toBe(true)
        expect(path.relative(right, left).startsWith("..")).toBe(true)
      }
    }
  })
})
