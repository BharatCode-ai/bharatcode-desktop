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
      data: "/home/alice/.local/share/BharatCode",
      cache: "/home/alice/.cache/BharatCode",
      config: "/home/alice/.config/BharatCode",
      state: "/home/alice/.local/state/BharatCode",
      recovery: "/home/alice/.local/state/BharatCode",
      tmp: "/tmp/BharatCode",
      bin: "/home/alice/.cache/BharatCode/bin",
      log: "/home/alice/.local/state/BharatCode/log",
      repos: "/home/alice/.local/share/BharatCode/repos",
      storage: "/home/alice/.local/share/BharatCode/storage",
      auth: "/home/alice/.local/share/BharatCode/auth.json",
      database: "/home/alice/.local/share/BharatCode/bharatcode.db",
    })
    expect(beta.data).toBe("/home/alice/.local/share/BharatCode Beta")
    expect(beta.auth).toBe("/home/alice/.local/share/BharatCode Beta/auth.json")
    expect(beta.database).toBe("/home/alice/.local/share/BharatCode Beta/bharatcode.db")
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
      data: "/Users/Alice/Library/Application Support/BharatCode",
      config: "/Users/Alice/Library/Preferences/BharatCode",
      cache: "/Users/Alice/Library/Caches/BharatCode",
      state: "/Users/Alice/Library/Application Support/BharatCode/State",
      recovery: "/Users/Alice/Library/Application Support/BharatCode Recovery",
      log: "/Users/Alice/Library/Logs/BharatCode",
      auth: "/Users/Alice/Library/Application Support/BharatCode/auth.json",
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
      data: "D:\\Local\\BharatCode Beta\\Data",
      config: "D:\\Roaming\\BharatCode Beta\\Config",
      cache: "D:\\Local\\BharatCode Beta\\Cache",
      recovery: "D:\\Local\\BharatCode Beta\\State",
      auth: "D:\\Local\\BharatCode Beta\\Data\\auth.json",
      database: "D:\\Local\\BharatCode Beta\\Data\\bharatcode.db",
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
