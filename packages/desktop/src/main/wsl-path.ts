import { posix, win32 } from "node:path"
import { isSafeWslDisplayName } from "./wsl-contract"
import type { WslExecute } from "./wsl-distro"

function closedLine(output: string) {
  const value = output.replace(/\r?\n$/u, "")
  if (!value || /[\u0000\r\n]/u.test(value)) throw new Error("wslpath returned malformed output")
  return value
}

function rejectControl(value: string) {
  if (!value || /[\u0000\r\n]/u.test(value)) throw new Error("WSL path contains a forbidden control character")
}

function uncDistribution(value: string): string | undefined {
  return value.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/iu)?.[1]
}

function sameWindowsPath(left: string, right: string) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
}

function sameLinuxPath(left: string, right: string) {
  return posix.normalize(left) === posix.normalize(right)
}

export function createWslPathTranslator(input: {
  wslExecutable: string
  selectedDisplayName: string
  execute: WslExecute
}): { translate: (path: string, mode: "windows" | "linux") => Promise<string> } {
  if (!isSafeWslDisplayName(input.selectedDisplayName)) throw new Error("Invalid selected WSL distribution")
  const prefix = ["--distribution", input.selectedDisplayName, "--exec"] as const

  const wslpath = async (path: string, mode: "windows" | "linux") =>
    closedLine(
      (
        await input.execute(input.wslExecutable, [
          ...prefix,
          "/usr/bin/wslpath",
          mode === "linux" ? "--unix" : "--windows",
          "--",
          path,
        ])
      ).stdout,
    )

  const verifySelectedUnc = (path: string) => {
    const distro = uncDistribution(path)
    if (path.startsWith("\\\\") && distro?.toLowerCase() !== input.selectedDisplayName.toLowerCase()) {
      throw new Error("WSL path does not belong to the selected distribution")
    }
  }

  const verifyDriveMount = async (windowsPath: string, linuxPath: string) => {
    const drive = windowsPath.match(/^([A-Za-z]):[\\/]/u)?.[1]?.toLowerCase()
    if (!drive) return
    const driveMount = `/mnt/${drive}`
    const mapped = linuxPath.match(/^\/mnt\/([A-Za-z])(?:\/|$)/u)?.[1]?.toLowerCase()
    if (mapped !== drive) throw new Error("WSL path is not on the requested mounted drive")
    const mount = closedLine(
      (
        await input.execute(input.wslExecutable, [
          ...prefix,
          "/usr/bin/findmnt",
          "--noheadings",
          "--output",
          "TARGET,FSTYPE",
          "--target",
          driveMount,
        ])
      ).stdout,
    )
    const match = mount.match(/^(\S+)\s+(9p|drvfs)$/iu)
    if (!match || match[1] !== driveMount) {
      throw new Error("WSL path is not on a mounted drive")
    }
  }

  return {
    translate: async (path, mode) => {
      rejectControl(path)
      if (mode === "linux") {
        if (!win32.isAbsolute(path)) throw new Error("Windows path must be absolute")
        verifySelectedUnc(path)
        const linux = await wslpath(path, "linux")
        if (!posix.isAbsolute(linux)) throw new Error("wslpath did not return an absolute Linux path")
        await verifyDriveMount(path, linux)
        const roundTrip = await wslpath(linux, "windows")
        verifySelectedUnc(roundTrip)
        if (!sameWindowsPath(path, roundTrip)) throw new Error("WSL path round trip failed")
        return linux
      }

      if (!posix.isAbsolute(path) || posix.normalize(path) !== path)
        throw new Error("Linux path must be canonical and absolute")
      const windows = await wslpath(path, "windows")
      if (!win32.isAbsolute(windows)) throw new Error("wslpath did not return an absolute Windows path")
      verifySelectedUnc(windows)
      const roundTrip = await wslpath(windows, "linux")
      if (!sameLinuxPath(path, roundTrip)) throw new Error("WSL path round trip failed")
      await verifyDriveMount(windows, path)
      return windows
    },
  }
}
