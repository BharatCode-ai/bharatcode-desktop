import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { execFile } from "node:child_process"
import { readFileSync } from "node:fs"

import { openExternalUrl, openWindowsHostUrl, shouldUseWindowsHostBrowser } from "./external-browser"

test("Windows launcher keeps OAuth URL in stdin and uses known folders only in the child", async () => {
  const url = "https://bharatcode.ai/auth?state=synthetic-private-state"
  const env = {
    SystemRoot: "C:\\Windows",
    LOCALAPPDATA: "C:\\isolated",
    BHARATCODE_SERVER_PASSWORD: "synthetic-secret",
  }
  let input = ""
  await openWindowsHostUrl(url, {
    env,
    execFile: ((file, args, options, callback) => {
      expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      expect(JSON.stringify(args)).not.toContain("synthetic-private-state")
      expect(args.at(-1)).toContain("GetFolderPath('LocalApplicationData')")
      expect(args.at(-1)).toContain("GetFolderPath('UserProfile')")
      expect(options.env).toEqual({ SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: undefined, TMP: undefined })
      expect(options.timeout).toBe(10_000)
      expect(options.windowsHide).toBe(true)
      const stdin = new PassThrough()
      stdin.on("data", (chunk) => {
        input += chunk.toString()
      })
      stdin.on("finish", () => callback(null, "accepted", ""))
      return { stdin, kill() {} }
    }) as typeof execFile,
  })
  expect(input).toBe(url)
  expect(env.LOCALAPPDATA).toBe("C:\\isolated")
})

test("Windows launcher rejects non-web and credential-bearing targets before launch", async () => {
  for (const url of ["file:///C:/secret", "javascript:alert(1)", "https://user:secret@bharatcode.ai", "--bad"]) {
    await expect(
      openWindowsHostUrl(url, {
        env: { SystemRoot: "C:\\Windows" },
        execFile: (() => {
          throw new Error("must not launch")
        }) as typeof execFile,
      }),
    ).rejects.toThrow("Could not open your Windows browser")
  }
})

test("Windows launcher failures are sanitized, with no URL or profile details", async () => {
  await expect(
    openWindowsHostUrl("https://bharatcode.ai/auth?state=private", {
      env: { SystemRoot: "C:\\Windows" },
      execFile: (() => {
        throw new Error("C:\\private synthetic-token")
      }) as typeof execFile,
    }),
  ).rejects.toThrow("Could not open your Windows browser")
})

test("sign-in production path uses the tested host handoff", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  expect(source).toContain("openExternalUrl(authorization.url")
  expect(source).not.toContain("shell.openExternal(authorization.url)")
})

describe("external browser opener", () => {
  test("Windows sign-in uses a host-profile launcher without changing the isolated app environment", async () => {
    const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\isolated\\Local", USERPROFILE: "C:\\isolated" }
    const before = { ...env }
    const opened: string[] = []
    await openExternalUrl("https://bharatcode.ai/auth", {
      platform: "win32",
      env,
      openWindowsHost: async (url) => {
        opened.push(url)
      },
      openExternal: () => {
        throw new Error("Must not inherit the isolated profile")
      },
    })
    expect(opened).toEqual(["https://bharatcode.ai/auth"])
    expect(env).toEqual(before)
  })

  test("Windows host failure is not retried through the isolated Electron opener", async () => {
    await expect(
      openExternalUrl("https://bharatcode.ai/auth", {
        platform: "win32",
        openWindowsHost: async () => {
          throw new Error("Host browser unavailable")
        },
        openExternal: () => {
          throw new Error("Unsafe fallback")
        },
      }),
    ).rejects.toThrow("Host browser unavailable")
  })

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
