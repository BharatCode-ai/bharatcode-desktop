import { describe, expect, test } from "bun:test"
import { createWslService, parseWslDiscovery, trustedWindowsExecutables, type WslExecute } from "./wsl-distro"

const quiet =
  "\uFEFFUbuntu Français\u0000\r\nDebian Detenido\u0000\r\nOpen SUSE\u0000\r\n日本語 Linux\u0000\r\n中文 Linux\u0000\r\nLegacy WSL\u0000\r\n"
const running = "\uFEFFUbuntu Français\u0000\r\n日本語 Linux\u0000\r\n"
const verbose = [
  "  NAME                   ÉTAT             VERSION",
  "* Ubuntu Français       En cours         2",
  "  Debian Detenido       Detenido         2",
  "  Open SUSE             Wird ausgeführt  2",
  "  日本語 Linux           実行中             2",
  "  中文 Linux            正在运行            2",
  "  Legacy WSL            Arrêté            1",
].join("\u0000\r\n")

const registry = (name = "Ubuntu Français", id = "{11111111-2222-3333-4444-555555555555}", defaultUid = "0x3e8") => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\${id}
    DistributionName    REG_SZ    ${name}
    DefaultUid          REG_DWORD ${defaultUid}
`

function executor(options?: {
  uid?: string
  user?: string
  registry?: () => string
  quiet?: () => string
  running?: () => string
  verbose?: () => string
}): {
  execute: WslExecute
  calls: Array<{ executable: string; args: readonly string[] }>
} {
  const calls: Array<{ executable: string; args: readonly string[] }> = []
  return {
    calls,
    execute: async (executable, args) => {
      calls.push({ executable, args })
      if (executable.endsWith("reg.exe")) return { stdout: options?.registry?.() ?? registry() }
      if (args.join(" ") === "--list --quiet") return { stdout: options?.quiet?.() ?? quiet }
      if (args.join(" ") === "--list --running --quiet") return { stdout: options?.running?.() ?? running }
      if (args.join(" ") === "--list --verbose") return { stdout: options?.verbose?.() ?? verbose }
      if (args.join(" ").endsWith("--exec /usr/bin/env LC_ALL=C /usr/bin/id")) {
        const uid = options?.uid ?? "1000"
        const user = options?.user ?? "private-user"
        return { stdout: `uid=${uid}(${user}) gid=${uid}(${user}) groups=${uid}(${user})\n` }
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`)
    },
  }
}

describe("locale-independent WSL discovery", () => {
  test("uses quiet names and rightmost versions while localized state stays opaque", () => {
    expect(parseWslDiscovery({ quiet, running, verbose })).toEqual([
      { displayName: "Ubuntu Français", version: 2, running: true },
      { displayName: "Debian Detenido", version: 2, running: false },
      { displayName: "Open SUSE", version: 2, running: false },
      { displayName: "日本語 Linux", version: 2, running: true },
      { displayName: "中文 Linux", version: 2, running: false },
      { displayName: "Legacy WSL", version: 1, running: false },
    ])
  })

  test("rejects duplicate, missing, ambiguous, and foreign rows", () => {
    for (const input of [
      { quiet: "Debian\nDebian\n", running: "", verbose: "NAME STATE VERSION\nDebian Stopped 2" },
      { quiet: "Debian\n", running: "", verbose: "NAME STATE VERSION\n" },
      { quiet: "Debian\n", running: "", verbose: "NAME STATE VERSION\nDebian Stopped two" },
      { quiet: "Debian\n", running: "Foreign\n", verbose: "NAME STATE VERSION\nDebian Stopped 2" },
      {
        quiet: "Debian\n",
        running: "",
        verbose: "NAME STATE VERSION\nDebian Stopped 2\nForeign Stopped 2",
      },
      { quiet: "bad/name\n", running: "", verbose: "NAME STATE VERSION\nbad/name Stopped 2" },
    ]) {
      expect(() => parseWslDiscovery(input)).toThrow()
    }
  })

  test("resolves only trusted System32 executables", () => {
    expect(trustedWindowsExecutables({ SystemRoot: "C:\\Windows" })).toEqual({
      wsl: "C:\\Windows\\System32\\wsl.exe",
      registry: "C:\\Windows\\System32\\reg.exe",
    })
    for (const SystemRoot of [undefined, "\\\\server\\Windows", "C:\\Windows\\..\\Private", "relative"] as const) {
      expect(() => trustedWindowsExecutables({ SystemRoot })).toThrow("trusted Windows system directory")
    }
  })
})

describe("main-only WSL selection service", () => {
  test("lists only WSL2 choices and persists only the safe selected display name", async () => {
    const command = executor()
    let stored: unknown
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })

    expect(await service.snapshot()).toEqual({
      enabled: false,
      revision: 0,
      distributions: [
        { displayName: "Ubuntu Français", version: 2, selected: false },
        { displayName: "Debian Detenido", version: 2, selected: false },
        { displayName: "Open SUSE", version: 2, selected: false },
        { displayName: "日本語 Linux", version: 2, selected: false },
        { displayName: "中文 Linux", version: 2, selected: false },
      ],
      status: { phase: "off" },
    })

    const selected = await service.configure({
      enabled: true,
      expectedRevision: 0,
      selectedDisplayName: "Ubuntu Français",
    })
    expect(selected).toEqual({
      enabled: true,
      revision: 1,
      selectedDisplayName: "Ubuntu Français",
      distributions: [
        { displayName: "Ubuntu Français", version: 2, selected: true },
        { displayName: "Debian Detenido", version: 2, selected: false },
        { displayName: "Open SUSE", version: 2, selected: false },
        { displayName: "日本語 Linux", version: 2, selected: false },
        { displayName: "中文 Linux", version: 2, selected: false },
      ],
      status: { phase: "ready" },
    })
    expect(stored).toEqual({
      schema: 1,
      enabled: true,
      revision: 1,
      selectedDisplayName: "Ubuntu Français",
    })
    expect(JSON.stringify(stored)).not.toContain("private-user")
    expect(JSON.stringify(stored)).not.toContain("11111111")
    expect(
      command.calls.some(
        (call) => call.args.join(" ") === "--distribution Ubuntu Français --exec /usr/bin/env LC_ALL=C /usr/bin/id",
      ),
    ).toBe(true)
  })

  test("rejects root before saving an enabled selection", async () => {
    const command = executor({ uid: "0" })
    let stored: unknown
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })

    expect(
      await service.configure({ enabled: true, expectedRevision: 0, selectedDisplayName: "Ubuntu Français" }),
    ).toMatchObject({ enabled: false, revision: 0, status: { phase: "error", code: "root-user" } })
    expect(stored).toBeUndefined()
  })

  test("rejects a registry default UID that does not match the selected distro user", async () => {
    const command = executor({ registry: () => registry("Ubuntu Français", undefined, "0x3e9") })
    let stored: unknown
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })

    expect(
      await service.configure({ enabled: true, expectedRevision: 0, selectedDisplayName: "Ubuntu Français" }),
    ).toMatchObject({ enabled: false, revision: 0, status: { phase: "error", code: "selection-invalid" } })
    expect(stored).toBeUndefined()
  })

  test("rejects a same-name registry replacement during identity resolution", async () => {
    let registryCalls = 0
    const command = executor({
      registry: () =>
        registryCalls++ === 0 ? registry() : registry("Ubuntu Français", "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"),
    })
    let stored: unknown
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })

    expect(
      await service.configure({ enabled: true, expectedRevision: 0, selectedDisplayName: "Ubuntu Français" }),
    ).toMatchObject({ enabled: false, revision: 0, status: { phase: "error", code: "selection-invalid" } })
    expect(stored).toBeUndefined()
  })

  test("rejects stale writes and detects a replaced or vanished selection", async () => {
    let instance = "{11111111-2222-3333-4444-555555555555}"
    let names = quiet
    const command = executor({ registry: () => registry("Ubuntu Français", instance), quiet: () => names })
    let stored: unknown
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })

    await service.configure({ enabled: true, expectedRevision: 0, selectedDisplayName: "Ubuntu Français" })
    await expect(service.configure({ enabled: false, expectedRevision: 0 })).rejects.toThrow("revision")

    instance = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"
    expect(await service.snapshot()).toMatchObject({ status: { phase: "error", code: "selection-invalid" } })

    instance = "{11111111-2222-3333-4444-555555555555}"
    names = quiet.replace("Ubuntu Français\u0000\r\n", "")
    expect(await service.retry()).toMatchObject({ status: { phase: "error", code: "selection-invalid" } })
  })

  test("allows only one concurrent writer for the same expected revision", async () => {
    const command = executor()
    let stored: unknown
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })
    const update = { enabled: true as const, expectedRevision: 0, selectedDisplayName: "Ubuntu Français" }

    const results = await Promise.allSettled([service.configure(update), service.configure(update)])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(stored).toEqual({ schema: 1, enabled: true, revision: 1, selectedDisplayName: "Ubuntu Français" })
  })

  test("serializes snapshot and configuration operations", async () => {
    const command = executor()
    let active = 0
    let maximum = 0
    const execute: WslExecute = async (executable, args) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      try {
        return await command.execute(executable, args)
      } finally {
        active -= 1
      }
    }
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute,
      readState: () => undefined,
      writeState: () => undefined,
    })

    await Promise.all([service.snapshot(), service.snapshot()])

    expect(maximum).toBe(3)
  })

  test("prevents a stale snapshot completion from overwriting a newer selection", async () => {
    const command = executor({
      registry: () => `${registry()}\n${registry("Debian Detenido", "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}")}`,
    })
    let stored: unknown
    let holdUbuntuIdentity = false
    let enterSnapshot!: () => void
    let releaseSnapshot!: () => void
    const snapshotEntered = new Promise<void>((resolve) => {
      enterSnapshot = resolve
    })
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const execute: WslExecute = async (executable, args) => {
      if (
        holdUbuntuIdentity &&
        args.join(" ") === "--distribution Ubuntu Français --exec /usr/bin/env LC_ALL=C /usr/bin/id"
      ) {
        enterSnapshot()
        await snapshotReleased
      }
      return command.execute(executable, args)
    }
    const service = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute,
      readState: () => stored,
      writeState: (value) => {
        stored = value
      },
    })
    await service.configure({ enabled: true, expectedRevision: 0, selectedDisplayName: "Ubuntu Français" })

    holdUbuntuIdentity = true
    const staleSnapshot = service.snapshot()
    await snapshotEntered
    let selectionSettled = false
    const newerSelection = service
      .configure({ enabled: true, expectedRevision: 1, selectedDisplayName: "Debian Detenido" })
      .finally(() => {
        selectionSettled = true
      })
    await Promise.resolve()
    expect(selectionSettled).toBe(false)
    releaseSnapshot()

    await staleSnapshot
    expect(await newerSelection).toMatchObject({
      enabled: true,
      revision: 2,
      selectedDisplayName: "Debian Detenido",
      status: { phase: "ready" },
    })
    holdUbuntuIdentity = false
    expect(await service.snapshot()).toMatchObject({
      enabled: true,
      revision: 2,
      selectedDisplayName: "Debian Detenido",
      status: { phase: "ready" },
    })
  })

  test("fails safely when WSL is unavailable or only WSL1 is installed", async () => {
    const unavailable = createWslService({
      platform: "linux",
      env: {},
      execute: executor().execute,
      readState: () => ({ schema: 1, enabled: true, revision: 1, selectedDisplayName: "Legacy WSL" }),
      writeState: () => undefined,
    })
    expect(await unavailable.snapshot()).toMatchObject({ status: { phase: "error", code: "wsl-unavailable" } })

    const command = executor()
    const wsl1 = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: command.execute,
      readState: () => ({ schema: 1, enabled: true, revision: 1, selectedDisplayName: "Legacy WSL" }),
      writeState: () => undefined,
    })
    expect(await wsl1.snapshot()).toMatchObject({ status: { phase: "error", code: "selection-invalid" } })

    const onlyLegacy = createWslService({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execute: executor({
        quiet: () => "Legacy WSL\n",
        running: () => "",
        verbose: () => "NAME STATE VERSION\nLegacy WSL Stopped 1\n",
      }).execute,
      readState: () => undefined,
      writeState: () => undefined,
    })
    expect(await onlyLegacy.snapshot()).toMatchObject({
      enabled: false,
      distributions: [],
      status: { phase: "error", code: "no-wsl2-distribution" },
    })
    expect(
      await onlyLegacy.configure({ enabled: true, expectedRevision: 0, selectedDisplayName: "Legacy WSL" }),
    ).toMatchObject({
      enabled: false,
      revision: 0,
      status: { phase: "error", code: "no-wsl2-distribution" },
    })
    expect(await onlyLegacy.retry()).toMatchObject({
      enabled: false,
      status: { phase: "error", code: "no-wsl2-distribution" },
    })
  })
})
