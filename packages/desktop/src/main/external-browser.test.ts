import { describe, expect, test } from "bun:test"

import { openExternalUrl, shouldUseWindowsHostBrowser } from "./external-browser"

describe("external browser opener", () => {
  test("uses the Windows host browser for WSL Linux sessions", async () => {
    const calls: Array<{ file: string; args: string[] }> = []

    await openExternalUrl("https://bharatcode.ai/auth", {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
      openExternal: async () => {
        throw new Error("should not use Electron opener in WSL")
      },
      execFile: (file, args, callback) => {
        calls.push({ file, args })
        callback(null)
      },
    })

    expect(shouldUseWindowsHostBrowser({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu-22.04" } })).toBe(true)
    expect(calls).toEqual([{ file: "explorer.exe", args: ["https://bharatcode.ai/auth"] }])
  })

  test("uses the provided Electron opener outside WSL", async () => {
    const opened: string[] = []

    await openExternalUrl("https://bharatcode.ai/auth", {
      platform: "linux",
      env: {},
      openExternal: async (url) => opened.push(url),
      execFile: () => {
        throw new Error("should not use explorer.exe outside WSL")
      },
    })

    expect(shouldUseWindowsHostBrowser({ platform: "linux", env: {} })).toBe(false)
    expect(opened).toEqual(["https://bharatcode.ai/auth"])
  })
})
