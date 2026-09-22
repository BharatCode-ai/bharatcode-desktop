import { expect, test } from "bun:test"
import {
  clearWslDistroState,
  requireWslIpcString,
  requireWslIpcStrings,
  wslServerIdToRestart,
  wslTerminalArgs,
} from "./policy"
import { expectOpencodeVersion, pendingRestartAfterWslInstall, wslServerIdsToStartOnInitialize } from "./startup"
import { createWslServersController, type WslServerConfig } from "./servers"
import { wslArgs } from "./runtime"

let persistedServers: WslServerConfig[] = []
let releaseOpencodeResolve: (() => void) | undefined

test("launch working directory is the verified Linux home, not the Windows app folder", () => {
  expect(wslArgs(["/runtime", "serve"], "Ubuntu", "fixture", "/home/Fixture Name")).toEqual([
    "-d",
    "Ubuntu",
    "--user",
    "fixture",
    "--cd",
    "/home/Fixture Name",
    "--",
    "/runtime",
    "serve",
  ])
  expect(wslArgs(["/bin/true"], "Ubuntu")).toEqual(["-d", "Ubuntu", "--", "/bin/true"])
})

test("bundled-runtime check does not require curl", async () => {
  persistedServers = []
  const checked: string[] = []
  const controller = createWslServersController("1.15.35", async () => new Promise<never>(() => {}), {
    ...testControllerOptions(),
    probeDistro: async (name) => ({ name, canExecute: true, hasBash: true, error: null }),
    resolveOpencode: async (name) => {
      checked.push(name)
      return null
    },
  })
  await controller.probeAddable(["Ubuntu"])
  expect(checked).toEqual(["Ubuntu"])
})

test("restart waits for shutdown acknowledgement and does not spawn after failed shutdown", async () => {
  for (const fails of [false, true]) {
    persistedServers = []
    const stopping = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    let spawns = 0
    const controller = createWslServersController(
      "1.15.35",
      async () => {
        spawns += 1
        return {
          url: `http://127.0.0.1:${43000 + spawns}`,
          username: "bharatcode",
          password: "private",
          listener: {
            onExit: () => undefined,
            stop: async () => {
              stopping.resolve()
              await complete.promise
              if (fails) throw new Error("private failure detail")
            },
          },
        }
      },
      { ...testControllerOptions(), resolveOpencode: async () => null },
    )
    await controller.addServer("Debian")
    await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
    const restart = controller.startServer("wsl:Debian")
    await stopping.promise
    expect(spawns).toBe(1)
    complete.resolve()
    await restart
    expect(spawns).toBe(fails ? 1 : 2)
    expect(controller.getState().servers[0].runtime.kind).toBe(fails ? "failed" : "ready")
    expect(JSON.stringify(controller.getState())).not.toContain("private failure detail")
    await controller.stopAll()
  }
})

test("keeps runtime credentials out of snapshots/events and revokes them on remove", async () => {
  persistedServers = []
  const authorizations: unknown[] = []
  const events: unknown[] = []
  let exited: (() => void) | undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: () => undefined,
        onExit: (cb) => {
          exited = () => cb(0, null)
        },
      },
      url: "http://127.0.0.1:4096",
      username: "bharatcode",
      password: "never-render-this",
    }),
    {
      ...testControllerOptions(),
      resolveOpencode: async () => null,
      onConnection: (id, connection) => authorizations.push({ id, connection }),
    },
  )
  controller.subscribe((event) => events.push(event))
  await controller.addServer("Debian")
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  expect(JSON.stringify(controller.getState())).not.toContain("never-render-this")
  expect(JSON.stringify(events)).not.toContain("never-render-this")
  expect(authorizations).toHaveLength(1)
  exited?.()
  expect(authorizations.at(-1)).toEqual({ id: "wsl:Debian", connection: undefined })
  await controller.startServer("wsl:Debian")
  await controller.removeServer("wsl:Debian")
  expect(authorizations.at(-1)).toEqual({ id: "wsl:Debian", connection: undefined })
  await controller.addServer("Debian")
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  controller.stopAll()
  expect(authorizations.at(-1)).toEqual({ id: "wsl:Debian", connection: undefined })
})

test("failed startup publishes a fixed outcome instead of the child error", async () => {
  persistedServers = []
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      throw new Error("secret-token private-path child-output")
    },
    { ...testControllerOptions(), resolveOpencode: async () => null },
  )
  await controller.addServer("Debian")
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "failed")
  expect(controller.getState().servers[0]?.runtime).toEqual({
    kind: "failed",
    message: "BharatCode could not start the WSL runtime. Check the selected distribution and retry.",
  })
})

test("starts every configured WSL server on initialization", () => {
  expect(
    wslServerIdsToStartOnInitialize([
      { id: "wsl:Debian", distro: "Debian" },
      { id: "wsl:Ubuntu-24.04", distro: "Ubuntu-24.04" },
    ]),
  ).toEqual(["wsl:Debian", "wsl:Ubuntu-24.04"])
})

test("rejects an update that did not install the desktop version", () => {
  expect(() => expectOpencodeVersion("1.16.2", "1.16.2")).not.toThrow()
  expect(() => expectOpencodeVersion("1.14.35", "1.16.2")).toThrow(
    "BharatCode update finished but Debian still reports 1.14.35; expected 1.16.2",
  )
})

test("restarts an existing distro server after updating OpenCode", () => {
  expect(
    wslServerIdToRestart(
      [
        {
          config: { id: "wsl:Debian", distro: "Debian" },
          runtime: { kind: "ready", url: "", username: null, password: null },
        },
      ],
      "Debian",
    ),
  ).toBe("wsl:Debian")
  expect(wslServerIdToRestart([], "Debian")).toBeUndefined()
})

test("clears cached distro probes when removing a WSL server", () => {
  expect(
    clearWslDistroState(
      { Debian: { name: "Debian", canExecute: true, hasBash: true, error: null } },
      {
        Debian: {
          distro: "Debian",
          resolvedPath: "/home/luke/.opencode/bin/opencode",
          version: "1.16.2",
          expectedVersion: "1.16.2",
          matchesDesktop: true,
          error: null,
        },
      },
      "Debian",
    ),
  ).toEqual({ distroProbes: {}, opencodeChecks: {} })
})

test("opens terminals for distro names containing spaces", () => {
  expect(wslTerminalArgs("Ubuntu Preview")).toEqual(["/c", "start", "", "wsl", "-d", "Ubuntu Preview"])
  for (const distro of ["Ubuntu & command", "Ubuntu|command", "%COMSPEC%", 'Ubuntu"', "-d", "Ubuntu\ncommand"]) {
    expect(() => wslTerminalArgs(distro)).toThrow()
  }
})

test("validates WSL IPC identifiers at the module boundary", () => {
  expect(requireWslIpcString("distro", "Debian")).toBe("Debian")
  expect(requireWslIpcStrings("distro", ["Debian", "Ubuntu"])).toEqual(["Debian", "Ubuntu"])
  expect(() => requireWslIpcString("distro", "")).toThrow("Invalid distro")
  expect(() => requireWslIpcString("server id", undefined)).toThrow("Invalid server id")
  expect(() => requireWslIpcStrings("distro", [])).toThrow("Invalid distro")
})

test("derives a required Windows restart from the post-install runtime probe", () => {
  expect(pendingRestartAfterWslInstall({ available: false, version: null, error: "WSL unavailable" })).toBe(true)
  expect(pendingRestartAfterWslInstall({ available: true, version: "WSL version: 2.6.1", error: null })).toBe(false)
})

test("ignores stale background OpenCode checks after removing a WSL server", async () => {
  persistedServers = []
  releaseOpencodeResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: () => undefined,
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    }),
    testControllerOptions(),
  )

  await controller.addServer("Debian")
  await waitFor(() => !!releaseOpencodeResolve)
  await controller.removeServer("wsl:Debian")
  releaseOpencodeResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().opencodeChecks).toEqual({})
})

test("ignores stale startup OpenCode checks after removing a WSL server", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  releaseOpencodeResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => new Promise<never>(() => undefined),
    testControllerOptions(),
  )

  await controller.initialize()
  await waitFor(() => !!releaseOpencodeResolve)
  await controller.removeServer("wsl:Debian")
  releaseOpencodeResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().opencodeChecks).toEqual({})
})

test("probes addable distros in parallel before checking OpenCode", async () => {
  persistedServers = []
  const started: string[] = []
  const release = new Map<string, () => void>()
  const opencode: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => {
      started.push(distro)
      await new Promise<void>((resolve) => release.set(distro, resolve))
      return { name: distro, canExecute: true, hasBash: true, error: null }
    },
    resolveOpencode: async (distro) => {
      opencode.push(distro)
      return "/home/me/.opencode/bin/opencode"
    },
  })

  const task = controller.probeAddable(["Debian", "Ubuntu"])
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual([])
  release.get("Debian")?.()
  release.get("Ubuntu")?.()
  await task

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual(["Debian", "Ubuntu"])
  expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian", "Ubuntu"])
})

test("does not check OpenCode in addable distros that cannot execute commands", async () => {
  persistedServers = []
  const opencode: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => ({
      name: distro,
      canExecute: distro === "Debian",
      hasBash: distro === "Debian",
      error: distro === "Debian" ? null : "Open Ubuntu once to finish setup",
    }),
    resolveOpencode: async (distro) => {
      opencode.push(distro)
      return "/home/me/.opencode/bin/opencode"
    },
  })

  await controller.probeAddable(["Debian", "Ubuntu"])

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual(["Debian"])
  expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian"])
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}

function testControllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: async () => "1.16.2",
    resolveOpencode: async () => {
      await new Promise<void>((resolve) => {
        releaseOpencodeResolve = resolve
      })
      return "/home/me/.opencode/bin/opencode"
    },
  }
}
