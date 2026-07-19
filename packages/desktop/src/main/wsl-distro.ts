import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { win32 } from "node:path"
import {
  applyWslConfigurationUpdate,
  isSafeWslDisplayName,
  parseStoredWslState,
  toWslSnapshot,
  type WslConfigurationUpdate,
  type WslErrorCode,
  type WslMainDistribution,
  type WslSnapshot,
  type WslStoredState,
  WslRevisionConflict,
} from "./wsl-contract"

export type WslExecute = (executable: string, args: readonly string[]) => Promise<{ stdout: string; stderr?: string }>

type DiscoveryInput = { quiet: string; running: string; verbose: string }
type WslDistribution = { displayName: string; version: number; running: boolean }

class WslServiceError extends Error {
  constructor(readonly code: WslErrorCode) {
    super(code)
    this.name = "WslServiceError"
  }
}

function lines(value: string): string[] {
  return value
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function parseWslDiscovery(input: DiscoveryInput): WslDistribution[] {
  const names = lines(input.quiet)
  if (names.length === 0 || new Set(names).size !== names.length || names.some((name) => !isSafeWslDisplayName(name))) {
    throw new Error("Invalid WSL distribution list")
  }

  const known = new Set(names)
  const runningNames = lines(input.running)
  if (new Set(runningNames).size !== runningNames.length || runningNames.some((name) => !known.has(name))) {
    throw new Error("Invalid running WSL distribution list")
  }

  const versions = new Map<string, number>()
  const orderedNames = [...names].sort((left, right) => right.length - left.length)
  let skippedHeader = false
  for (const rawLine of lines(input.verbose)) {
    const line = rawLine.replace(/^\*\s*/u, "")
    const name = orderedNames.find((candidate) => line === candidate || line.startsWith(`${candidate} `))
    if (!name) {
      if (!skippedHeader && versions.size === 0) {
        skippedHeader = true
        continue
      }
      throw new Error("Unexpected WSL verbose row")
    }
    if (versions.has(name)) throw new Error("Duplicate WSL verbose row")
    const suffix = line.slice(name.length)
    const match = suffix.match(/\s(\d+)\s*$/u)
    if (!match) throw new Error("Missing numeric WSL version")
    const version = Number(match[1])
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid WSL version")
    versions.set(name, version)
  }

  if (versions.size !== names.length) throw new Error("Incomplete WSL verbose list")
  const runningSet = new Set(runningNames)
  return names.map((displayName) => ({
    displayName,
    version: versions.get(displayName)!,
    running: runningSet.has(displayName),
  }))
}

export function trustedWindowsExecutables(env: Readonly<Record<string, string | undefined>>): {
  wsl: string
  registry: string
} {
  const root = env.SystemRoot
  if (!root || !/^[A-Za-z]:\\[^\\/]+(?:\\[^\\/]+)*$/u.test(root) || root.split("\\").includes("..")) {
    throw new Error("Unable to resolve trusted Windows system directory")
  }
  const normalized = win32.normalize(root)
  if (!win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    throw new Error("Unable to resolve trusted Windows system directory")
  }
  return {
    wsl: win32.join(normalized, "System32", "wsl.exe"),
    registry: win32.join(normalized, "System32", "reg.exe"),
  }
}

function nodeExecute(executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function parseRegistryIdentity(output: string, displayName: string): { instanceId: string; defaultUid: number } {
  const sections = output.replaceAll("\u0000", "").split(/(?=HKEY_CURRENT_USER\\)/u)
  const matches: Array<{ instanceId: string; defaultUid: number }> = []
  for (const section of sections) {
    const heading = section.match(/^HKEY_CURRENT_USER\\[^\r\n]+\\(\{[0-9A-Fa-f-]{36}\})/u)
    const name = section.match(/^\s*DistributionName\s+REG_SZ\s+(.+?)\s*$/mu)?.[1]
    if (!heading || name !== displayName) continue
    const id = heading[1]
    if (!/^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/u.test(id)) {
      throw new WslServiceError("selection-invalid")
    }
    const uidText = section.match(/^\s*DefaultUid\s+REG_DWORD\s+(0x[0-9A-Fa-f]+|\d+)\s*$/mu)?.[1]
    if (!uidText) throw new WslServiceError("selection-invalid")
    const defaultUid = Number.parseInt(uidText, uidText.startsWith("0x") ? 16 : 10)
    if (!Number.isSafeInteger(defaultUid) || defaultUid < 0) throw new WslServiceError("selection-invalid")
    matches.push({ instanceId: id.toLowerCase(), defaultUid })
  }
  if (matches.length !== 1) throw new WslServiceError("selection-invalid")
  return matches[0]
}

function safeUid(value: string): number {
  const text = value.trim()
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) throw new WslServiceError("selection-invalid")
  const uid = Number(text)
  if (!Number.isSafeInteger(uid)) throw new WslServiceError("selection-invalid")
  if (uid === 0) throw new WslServiceError("root-user")
  return uid
}

function parseIdentityObservation(value: string): { user: string; uid: number } {
  const match = value.trim().match(/^uid=((?:0|[1-9]\d*))\(([a-z_][a-z0-9_-]{0,31})\)(?:\s|$)/u)
  if (!match) throw new WslServiceError("selection-invalid")
  return { uid: safeUid(match[1]), user: match[2] }
}

type WslServiceOptions = {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  execute?: WslExecute
  readState: () => unknown
  writeState: (value: WslStoredState) => void
}

type PrivateIdentity = { displayName: string; instanceIdSha256: string; user: string; uid: number }

export function createWslService(options: WslServiceOptions): {
  snapshot: () => Promise<WslSnapshot>
  configure: (update: WslConfigurationUpdate) => Promise<WslSnapshot>
  retry: () => Promise<WslSnapshot>
} {
  const execute = options.execute ?? nodeExecute
  let privateIdentity: PrivateIdentity | undefined
  let operationTail: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation)
    operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const discover = async (): Promise<{
    executables: ReturnType<typeof trustedWindowsExecutables>
    list: WslDistribution[]
  }> => {
    if (options.platform !== "win32") throw new WslServiceError("wsl-unavailable")
    let executables: ReturnType<typeof trustedWindowsExecutables>
    try {
      executables = trustedWindowsExecutables(options.env)
    } catch {
      throw new WslServiceError("wsl-unavailable")
    }
    let output: Awaited<ReturnType<WslExecute>>[]
    try {
      output = await Promise.all([
        execute(executables.wsl, ["--list", "--quiet"]),
        execute(executables.wsl, ["--list", "--running", "--quiet"]),
        execute(executables.wsl, ["--list", "--verbose"]),
      ])
    } catch {
      throw new WslServiceError("wsl-unavailable")
    }
    try {
      return {
        executables,
        list: parseWslDiscovery({ quiet: output[0].stdout, running: output[1].stdout, verbose: output[2].stdout }),
      }
    } catch {
      throw new WslServiceError("selection-invalid")
    }
  }

  const resolveIdentity = async (
    executables: ReturnType<typeof trustedWindowsExecutables>,
    displayName: string,
  ): Promise<PrivateIdentity> => {
    try {
      const registry = await execute(executables.registry, [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
        "/s",
      ])
      const registryIdentity = parseRegistryIdentity(registry.stdout, displayName)
      const identity = await execute(executables.wsl, [
        "--distribution",
        displayName,
        "--exec",
        "/usr/bin/env",
        "LC_ALL=C",
        "/usr/bin/id",
      ])
      const observation = parseIdentityObservation(identity.stdout)
      const rediscovered = await discover()
      const selected = rediscovered.list.find((item) => item.displayName === displayName)
      if (!selected || selected.version !== 2) throw new WslServiceError("selection-invalid")
      const registryAfter = await execute(executables.registry, [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
        "/s",
      ])
      const revalidated = parseRegistryIdentity(registryAfter.stdout, displayName)
      if (
        registryIdentity.instanceId !== revalidated.instanceId ||
        registryIdentity.defaultUid !== revalidated.defaultUid ||
        revalidated.defaultUid !== observation.uid
      ) {
        throw new WslServiceError("selection-invalid")
      }
      return {
        displayName,
        instanceIdSha256: createHash("sha256").update(registryIdentity.instanceId).digest("hex"),
        user: observation.user,
        uid: observation.uid,
      }
    } catch (error) {
      if (error instanceof WslServiceError) throw error
      throw new WslServiceError("selection-invalid")
    }
  }

  const render = async (state: WslStoredState, compareIdentity: boolean): Promise<WslSnapshot> => {
    try {
      const discovered = await discover()
      const distributions: WslMainDistribution[] = discovered.list
      if (!state.enabled) {
        const status = distributions.some((distribution) => distribution.version === 2)
          ? ({ phase: "off" } as const)
          : ({ phase: "error", code: "no-wsl2-distribution" } as const)
        return toWslSnapshot({ stored: state, distributions, status })
      }

      const selected = discovered.list.find((item) => item.displayName === state.selectedDisplayName)
      if (!selected || selected.version !== 2) throw new WslServiceError("selection-invalid")
      const resolved = await resolveIdentity(discovered.executables, selected.displayName)
      if (
        compareIdentity &&
        privateIdentity &&
        (resolved.displayName !== privateIdentity.displayName ||
          resolved.instanceIdSha256 !== privateIdentity.instanceIdSha256)
      ) {
        throw new WslServiceError("selection-invalid")
      }
      privateIdentity = resolved
      return toWslSnapshot({ stored: state, distributions, status: { phase: "ready" }, privateRuntime: resolved })
    } catch (error) {
      const code = error instanceof WslServiceError ? error.code : "wsl-unavailable"
      return toWslSnapshot({ stored: state, distributions: [], status: { phase: "error", code } })
    }
  }

  return {
    snapshot: () => serialize(() => render(parseStoredWslState(options.readState()), true)),
    configure: (update) =>
      serialize(async () => {
        const state = parseStoredWslState(options.readState())
        if (state.revision !== update.expectedRevision) {
          applyWslConfigurationUpdate(state, update)
        }
        if (!update.enabled) {
          const next = applyWslConfigurationUpdate(parseStoredWslState(options.readState()), update)
          options.writeState(next)
          privateIdentity = undefined
          return render(next, false)
        }

        try {
          const discovered = await discover()
          if (!discovered.list.some((item) => item.version === 2)) {
            throw new WslServiceError("no-wsl2-distribution")
          }
          const selected = discovered.list.find((item) => item.displayName === update.selectedDisplayName)
          if (!selected) throw new WslServiceError("selection-invalid")
          if (selected.version !== 2) throw new WslServiceError("selection-invalid")
          const resolved = await resolveIdentity(discovered.executables, selected.displayName)
          const next = applyWslConfigurationUpdate(parseStoredWslState(options.readState()), update)
          options.writeState(next)
          privateIdentity = resolved
          return toWslSnapshot({
            stored: next,
            distributions: discovered.list,
            status: { phase: "ready" },
            privateRuntime: resolved,
          })
        } catch (error) {
          if (error instanceof WslRevisionConflict) throw error
          const code = error instanceof WslServiceError ? error.code : "selection-invalid"
          let distributions: WslMainDistribution[] = []
          try {
            distributions = (await discover()).list
          } catch {
            // Keep the renderer error closed when discovery is unavailable.
          }
          return toWslSnapshot({ stored: state, distributions, status: { phase: "error", code } })
        }
      }),
    retry: () => serialize(() => render(parseStoredWslState(options.readState()), true)),
  }
}
