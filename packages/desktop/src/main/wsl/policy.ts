import type { WslDistroProbe, WslOpencodeCheck, WslServerItem } from "../../preload/types"
import { nativeT } from "../native-translations"

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  opencodeChecks: Record<string, WslOpencodeCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextOpencodeChecks = { ...opencodeChecks }
  delete nextDistroProbes[distro]
  delete nextOpencodeChecks[distro]
  return { distroProbes: nextDistroProbes, opencodeChecks: nextOpencodeChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  // This one action uses cmd.exe's `start`; reject its expansion/operators
  // rather than treating an IPC string as a command fragment.
  if (distro && !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u.test(distro)) {
    throw new Error(nativeT("desktop.wsl.error.request"))
  }
  return ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])]
}

export function requireWslIpcString(name: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Invalid ${name}`)
}

export function requireWslIpcStrings(name: string, value: unknown) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}`)
  const values = value.map((item) => requireWslIpcString(name, item))
  if (values.length > 0) return values
  throw new Error(`Invalid ${name}`)
}
