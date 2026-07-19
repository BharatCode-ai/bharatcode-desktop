import { describe, expect, test } from "bun:test"
import { createWslPathTranslator } from "./wsl-path"
import type { WslExecute } from "./wsl-distro"

function translator(options?: {
  linux?: string
  windows?: string
  roundTripLinux?: string
  roundTripWindows?: string
  mount?: string
  fail?: boolean
}) {
  const calls: Array<{ executable: string; args: readonly string[] }> = []
  let unixCalls = 0
  let windowsCalls = 0
  const execute: WslExecute = async (executable, args) => {
    calls.push({ executable, args })
    if (options?.fail) throw new Error("wslpath failed")
    if (args.includes("/usr/bin/findmnt")) return { stdout: options?.mount ?? "/mnt/c 9p\n" }
    if (args.includes("--unix")) {
      unixCalls += 1
      return {
        stdout: `${unixCalls === 1 ? (options?.linux ?? "/mnt/c/Users/Alice/Project") : (options?.roundTripLinux ?? "/home/alice/project")}\n`,
      }
    }
    if (args.includes("--windows")) {
      windowsCalls += 1
      return {
        stdout: `${windowsCalls === 1 ? (options?.windows ?? "C:\\Users\\Alice\\Project") : (options?.roundTripWindows ?? "C:\\Users\\Alice\\Project")}\r\n`,
      }
    }
    throw new Error(`unexpected command ${args.join(" ")}`)
  }
  return {
    calls,
    service: createWslPathTranslator({
      wslExecutable: "C:\\Windows\\System32\\wsl.exe",
      selectedDisplayName: "Ubuntu 24.04",
      execute,
    }),
  }
}

describe("shell-free selected-distro wslpath translation", () => {
  test("translates Windows to Linux and verifies drive mount plus round trip", async () => {
    const target = translator()
    expect(await target.service.translate("C:\\Users\\Alice\\Project", "linux")).toBe("/mnt/c/Users/Alice/Project")
    expect(target.calls.every((call) => call.executable === "C:\\Windows\\System32\\wsl.exe")).toBe(true)
    expect(target.calls[0].args).toEqual([
      "--distribution",
      "Ubuntu 24.04",
      "--exec",
      "/usr/bin/wslpath",
      "--unix",
      "--",
      "C:\\Users\\Alice\\Project",
    ])
    expect(target.calls.find((call) => call.args.includes("/usr/bin/findmnt"))?.args.at(-1)).toBe("/mnt/c")
    expect(JSON.stringify(target.calls)).not.toMatch(/sh|-c|powershell|cmd\.exe/i)
  })

  test("translates Linux to a selected-distro UNC path and verifies round trip", async () => {
    const target = translator({
      windows: "\\\\wsl.localhost\\Ubuntu 24.04\\home\\alice\\project",
      linux: "/home/alice/project",
    })
    expect(await target.service.translate("/home/alice/project", "windows")).toBe(
      "\\\\wsl.localhost\\Ubuntu 24.04\\home\\alice\\project",
    )
  })

  test("rejects NUL/newline input before execution", async () => {
    const target = translator()
    for (const value of ["C:\\bad\u0000path", "C:\\bad\npath", "/bad\rpath"]) {
      await expect(target.service.translate(value, "linux")).rejects.toThrow("control")
    }
    expect(target.calls).toHaveLength(0)
  })

  test("rejects wrong-distro UNC, unmounted drives, and failed round trips", async () => {
    await expect(
      translator({ windows: "\\\\wsl.localhost\\Other\\home\\alice", roundTripLinux: "/home/alice" }).service.translate(
        "/home/alice",
        "windows",
      ),
    ).rejects.toThrow("selected distribution")
    await expect(translator({ mount: "/ ext4\n" }).service.translate("C:\\Users\\Alice", "linux")).rejects.toThrow(
      "mounted drive",
    )
    await expect(
      translator({ roundTripWindows: "D:\\Different" }).service.translate("C:\\Users\\Alice", "linux"),
    ).rejects.toThrow("round trip")
    await expect(
      translator({ windows: "C:\\Users\\Alice", linux: "/different" }).service.translate("/home/alice", "windows"),
    ).rejects.toThrow("round trip")
  })

  test("fails closed without a Windows-path fallback when wslpath fails", async () => {
    const target = translator({ fail: true })
    await expect(target.service.translate("C:\\Users\\Alice", "linux")).rejects.toThrow("wslpath failed")
  })
})
