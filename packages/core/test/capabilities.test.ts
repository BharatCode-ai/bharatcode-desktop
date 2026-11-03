import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Capabilities } from "../src/capabilities"

const timeout = process.platform === "win32" ? 60_000 : 5_000

function acl(file: string, script: string) {
  const result = spawnSync(
    path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $p=$env:BC_TEST_FILE; ${script}`],
    {
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, BC_TEST_FILE: file },
      windowsHide: true,
      timeout: 15_000,
    },
  )
  expect(result.status).toBe(0)
}

async function privateTemp() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
  try {
    // POSIX mode bits do not create a private Windows fixture. Restrict only
    // this freshly owned test root; production must never repair existing ACLs.
    if (process.platform === "win32")
      acl(
        directory,
        "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); [IO.Directory]::SetAccessControl($p,$acl)",
      )
    return directory
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function broad(file: string, enabled: boolean) {
  if (process.platform !== "win32") return fs.chmod(file, enabled ? 0o666 : 0o600)
  acl(
    file,
    `$acl=[IO.File]::GetAccessControl($p); $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); ${enabled ? "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'))" : "$acl.PurgeAccessRules($sid)"}; [IO.File]::SetAccessControl($p,$acl)`,
  )
}

test("configuration reporting distinguishes saved choices from runtime defaults without exposing secrets", () => {
  const state: Capabilities.State = { version: 1, installed: { github: { enabled: true }, figma: { enabled: false } } }
  const config = {
    mcp: {
      github: { type: "remote" as const, url: "https://api.githubcopilot.com/mcp/", enabled: false },
      figma: { type: "remote" as const, url: "https://private.invalid", headers: { Authorization: "private-token" } },
      unrelated: { type: "local" as const, command: ["/private/command"] },
    },
  }
  const before = JSON.stringify(config)
  const report = Capabilities.configuration(state, config, "/private/data")
  expect(report.github).toEqual({ enabled: false, custom: true })
  expect(report.figma).toEqual({ enabled: true, custom: true })
  expect(report.linear).toEqual({ enabled: false, custom: false })
  expect(report.unrelated).toBeUndefined()
  expect(JSON.stringify(report)).not.toMatch(/private|Authorization|command|https/)
  expect(JSON.stringify(config)).toBe(before)
})

test(
  "configuration reporting recognizes unchanged defaults and the exact bundled skill directory",
  async () => {
    const data = await privateTemp()
    try {
      const store = Capabilities.store({ data, desktop: true })
      await store.change("github", "enable")
      const state = await store.read()
      const config = await store.overlay()
      expect(Capabilities.configuration(state, config, data).github).toEqual({ enabled: true, custom: false })
      expect(Capabilities.configuration(state, config, data)["superpowers-obra"]).toEqual({
        enabled: true,
        custom: false,
      })
      const disabled = { version: 1 as const, installed: {} }
      expect(Capabilities.configuration(disabled, config, data).github).toEqual({ enabled: true, custom: true })
      expect(
        Capabilities.configuration(state, { skills: { paths: ["/unrelated/superpowers/skills"] } }, data)[
          "superpowers-obra"
        ],
      ).toEqual({ enabled: false, custom: true })
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "native Desktop imports only its own previous store, once, without changing source bytes",
  async () => {
    const root = await privateTemp()
    try {
      const userData = path.join(root, "electron")
      const data = path.join(root, "native")
      await fs.mkdir(userData, { mode: 0o700 })
      const file = path.join(userData, "bharatcode.capabilities")
      const text = JSON.stringify({
        "state.v1": {
          version: 1,
          installed: {
            "superpowers-obra": { id: "superpowers-obra", enabled: false },
            github: { id: "github", enabled: true },
          },
        },
        unrelated: "do-not-import",
      })
      await fs.writeFile(file, text, { mode: 0o600 })
      await Capabilities.migrateDesktop({ data, userData })
      expect((await Capabilities.store({ data, desktop: true }).read()).installed).toEqual({
        "superpowers-obra": { enabled: false },
        github: { enabled: true },
      })
      expect(await fs.readFile(file, "utf8")).toBe(text)
      await Capabilities.store({ data, desktop: true }).change("github", "disable")
      await fs.writeFile(file, "malformed-old-source")
      await Capabilities.migrateDesktop({ data, userData })
      expect((await Capabilities.store({ data, desktop: true }).read()).installed.github.enabled).toBe(false)
      expect(
        (await Capabilities.store({ data: path.join(root, "wsl"), desktop: true }).read()).installed.github,
      ).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "missing legacy source is harmless; malformed, linked and writable sources fail without publication",
  async () => {
    const root = await privateTemp()
    try {
      const userData = path.join(root, "electron")
      const data = path.join(root, "data")
      await Capabilities.migrateDesktop({ data, userData })
      await fs.mkdir(userData, { mode: 0o700 })
      await Capabilities.migrateDesktop({ data, userData })
      const file = path.join(userData, "bharatcode.capabilities")
      const text = '{"state.v1":{"version":1,"installed":{}}}'
      await fs.writeFile(file, "private-malformed-value", { mode: 0o600 })
      await expect(Capabilities.migrateDesktop({ data, userData })).rejects.toThrow("Capability state is unavailable")
      expect(await fs.readFile(file, "utf8")).toBe("private-malformed-value")
      await fs.writeFile(file, text)
      await broad(file, true)
      await expect(Capabilities.migrateDesktop({ data, userData })).rejects.toThrow("Capability state is unavailable")
      await broad(file, false)
      const original = path.join(userData, "original")
      await fs.rename(file, original)
      if (process.platform === "win32") await fs.link(original, file)
      else await fs.symlink(original, file)
      await expect(Capabilities.migrateDesktop({ data, userData })).rejects.toThrow("Capability state is unavailable")
      await expect(fs.stat(path.join(data, "bharatcode-capabilities.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "legacy choices migrate once, retaining disabled defaults and new choices on retry",
  async () => {
    const data = await privateTemp()
    try {
      const legacy = {
        version: 1,
        installed: {
          "superpowers-obra": { id: "superpowers-obra", enabled: false, health: { message: "private-old-detail" } },
          github: { id: "github", enabled: true },
        },
      }
      const store = Capabilities.store({ data, desktop: true })
      await store.migrate(legacy)
      expect((await store.read()).installed).toEqual({
        "superpowers-obra": { enabled: false },
        github: { enabled: true },
      })
      expect(JSON.stringify(await store.read())).not.toMatch(/legacy|private-old-detail/)
      await store.change("github", "disable")
      const restarted = Capabilities.store({ data, desktop: true })
      await restarted.migrate(legacy)
      expect((await restarted.read()).installed.github.enabled).toBe(false)
      await restarted.migrate({ invalid: true })
      expect((await restarted.read()).installed.github.enabled).toBe(false)
      expect(await fs.readFile(path.join(data, "bharatcode-capabilities.json"), "utf8")).not.toContain(
        "private-old-detail",
      )
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "migration retires only exact old managed settings, without modifying caller data",
  async () => {
    const data = await privateTemp()
    try {
      const store = Capabilities.store({ data, desktop: true })
      await store.migrate({
        version: 1,
        installed: {
          "superpowers-obra": { id: "superpowers-obra", enabled: false },
          github: { id: "github", enabled: true },
          figma: { id: "figma", enabled: true },
          linear: { id: "linear", enabled: true },
        },
      })
      await store.change("github", "uninstall")
      const config = {
        mcp: {
          github: { enabled: true, url: "https://api.githubcopilot.com/mcp/", type: "remote" as const },
          figma: { type: "remote" as const, url: "https://custom.invalid", enabled: true },
          linear: { type: "remote" as const, url: "https://mcp.linear.app/mcp", enabled: false },
          sentry: { type: "remote" as const, url: "https://mcp.sentry.dev/mcp", enabled: true },
        },
        skills: { paths: ["C:\\Apps\\BharatCode\\resources\\capabilities\\superpowers\\skills", "/my/skills"] },
      }
      const before = JSON.stringify(config)
      const result = await store.filterLegacy(config)
      expect(result.mcp?.github).toBeUndefined()
      expect(result.mcp?.figma).toEqual(config.mcp.figma)
      expect(result.mcp?.linear).toEqual(config.mcp.linear)
      expect(result.mcp?.sentry).toEqual(config.mcp.sentry)
      expect(result.skills?.paths).toEqual(["/my/skills"])
      expect(JSON.stringify(config)).toBe(before)
      const withSecret = { mcp: { github: { ...config.mcp.github, headers: { Authorization: "private" } } } }
      expect(await store.filterLegacy(withSecret)).toEqual(withSecret)
      expect(
        await Capabilities.store({ data: path.join(data, "independent"), desktop: true }).filterLegacy(config),
      ).toEqual(config)
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "invalid legacy records fail closed without publishing a partial migration",
  async () => {
    const data = await privateTemp()
    try {
      const store = Capabilities.store({ data, desktop: true })
      for (const legacy of [
        { version: 2, installed: {} },
        { version: 1, installed: { github: { id: "figma", enabled: true } } },
        { version: 1, installed: { github: { id: "github", enabled: "true" } } },
        { version: 1, installed: { unknown: { id: "unknown", enabled: true } } },
      ])
        await expect(store.migrate(legacy)).rejects.toThrow("Capability state is unavailable")
      await expect(fs.stat(path.join(data, "bharatcode-capabilities.json"))).rejects.toMatchObject({ code: "ENOENT" })
      await store.migrate(undefined)
      await expect(fs.stat(path.join(data, "bharatcode-capabilities.json"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(Capabilities.store({ data, desktop: false }).migrate({ version: 1, installed: {} })).rejects.toThrow(
        "Capability state is unavailable",
      )
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "marketplace changes survive restart without editing runtime configuration",
  async () => {
    const data = await privateTemp()
    try {
      const config = path.join(data, "opencode.jsonc")
      await fs.writeFile(config, '// preserve comments\n{"mcp":{"github":{"url":"https://custom.invalid"}}}')
      const before = await fs.readFile(config, "utf8")
      const store = Capabilities.store({ data, desktop: false })
      expect((await store.read()).installed).toEqual({})
      await store.change("github", "install")
      expect((await store.overlay()).mcp).toEqual({})
      await store.change("github", "enable")
      const restarted = Capabilities.store({ data, desktop: false })
      expect((await restarted.overlay()).mcp?.github).toEqual({
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        enabled: true,
      })
      await restarted.change("github", "disable")
      expect((await restarted.overlay()).mcp).toEqual({})
      await restarted.change("github", "uninstall")
      expect((await restarted.read()).installed).toEqual({})
      expect(await fs.readFile(config, "utf8")).toBe(before)
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "independent runtime roots and concurrent capability changes do not overwrite each other",
  async () => {
    const root = await privateTemp()
    try {
      const a = Capabilities.store({ data: path.join(root, "native"), desktop: false })
      const b = Capabilities.store({ data: path.join(root, "wsl"), desktop: false })
      await Promise.all([a.change("github", "enable"), a.change("figma", "enable")])
      expect(Object.keys((await a.read()).installed).sort()).toEqual(["figma", "github"])
      expect((await b.read()).installed).toEqual({})
      await expect(a.change("not-a-capability", "enable")).rejects.toThrow("Unknown BharatCode capability")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "Desktop defaults materialize the exact bundled skills; disabling survives restart",
  async () => {
    const data = await privateTemp()
    try {
      const store = Capabilities.store({ data, desktop: true })
      const overlay = await store.overlay()
      const directory = overlay.skills?.paths?.[0]!
      expect(directory.startsWith(data + path.sep)).toBe(true)
      expect(await fs.readFile(path.join(directory, "using-superpowers/SKILL.md"), "utf8")).toContain("Superpowers")
      expect(await store.overlay()).toEqual(overlay)
      await store.change("superpowers-obra", "disable")
      expect((await Capabilities.store({ data, desktop: true }).overlay()).skills?.paths).toEqual([])
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

// Speaks newline-delimited JSON-RPC to the bundled server exactly as the MCP client does.
async function memoryServer(config: { command: string[]; environment?: Record<string, string> }, cwd: string) {
  const child = Bun.spawn(config.command, { cwd, env: { ...process.env, ...config.environment }, stdin: "pipe" })
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
  const state = { buffer: "" }
  const send = (id: number, method: string, params: object) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  const request = async (id: number, method: string, params: object) => {
    send(id, method, params)
    return response(id)
  }
  const response = async (id: number) => {
    while (true) {
      const line = state.buffer.split("\n").find((entry) => entry.includes(`"id":${id}`))
      if (line) return JSON.parse(line).result
      const chunk = await lines.read()
      if (chunk.done) throw new Error("memory server exited")
      state.buffer += chunk.value
    }
  }
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
  return {
    instructions: initialized.instructions as string,
    send,
    request,
    response,
    notified: (method: string) => state.buffer.includes(`"method":"${method}"`),
    close: () => child.kill(),
  }
}

test(
  "project memory is off until installed, then runs the bundled server and remembers facts across connections",
  async () => {
    const data = await privateTemp()
    try {
      const store = Capabilities.store({ data, desktop: true })
      expect((await store.read()).installed["project-memory"]).toBeUndefined()
      expect((await store.overlay()).mcp?.memory).toBeUndefined()
      // One click: installing a defaultEnabled capability turns it on.
      await store.change("project-memory", "install")
      const overlay = await store.overlay()
      const memory = overlay.mcp?.memory
      if (!memory || !("type" in memory) || memory.type !== "local")
        throw new Error("project memory is not a local MCP server")
      expect(memory.command[0]).toBe(process.execPath)
      expect(memory.command[1].startsWith(data + path.sep)).toBe(true)
      expect(memory.environment?.BHARATCODE_MEMORY_DIR).toBe(path.join(data, "memory"))
      expect(await store.overlay()).toEqual(overlay)
      expect(Capabilities.configuration(await store.read(), overlay, data)["project-memory"]).toEqual({
        enabled: true,
        custom: false,
      })

      const project = path.join(data, "project")
      await fs.mkdir(project)
      const first = await memoryServer(memory, project)
      try {
        expect(first.instructions).toContain("save_memory tool description")
        const before = await first.request(2, "tools/list", {})
        expect(before.tools[0].description).toContain("No facts saved yet.")
        const saved = await first.request(3, "tools/call", {
          name: "save_memory",
          arguments: { fact: "This project uses Bun, not npm." },
        })
        expect(saved.isError).toBe(false)
        // The same open connection learns about the fact, so the next chat sees it
        // without reconnecting the server.
        expect(first.notified("notifications/tools/list_changed")).toBe(true)
        const after = await first.request(4, "tools/list", {})
        expect(after.tools[0].description).toContain("[1] This project uses Bun, not npm.")
      } finally {
        first.close()
      }
      const second = await memoryServer(memory, project)
      try {
        const listed = await second.request(2, "tools/list", {})
        expect(listed.tools[0].description).toContain("[1] This project uses Bun, not npm.")
        // Parallel tool calls arrive together; none of the facts may be lost.
        for (const [id, fact] of [
          [3, "Tests run with bun test."],
          [4, "Docs live in docs/."],
          [5, "Releases use the beta channel first."],
        ] as const)
          second.send(id, "tools/call", { name: "save_memory", arguments: { fact } })
        for (const id of [3, 4, 5]) expect((await second.response(id)).isError).toBe(false)
        const after = await second.request(6, "tools/list", {})
        expect(after.tools[0].description).toContain("[4] Releases use the beta channel first.")
      } finally {
        second.close()
      }

      await store.change("project-memory", "disable")
      expect((await Capabilities.store({ data, desktop: true }).overlay()).mcp?.memory).toBeUndefined()
      expect((await Capabilities.store({ data, desktop: false }).overlay()).mcp?.memory).toBeUndefined()
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "malformed state fails closed and does not get overwritten",
  async () => {
    const data = await privateTemp()
    try {
      const file = path.join(data, "bharatcode-capabilities.json")
      await fs.writeFile(file, "{invalid", { mode: 0o600 })
      const store = Capabilities.store({ data, desktop: true })
      await expect(store.change("github", "enable")).rejects.toThrow("Capability state is unavailable")
      expect(await fs.readFile(file, "utf8")).toBe("{invalid")
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test(
  "altered bundled files are preserved and rejected, never silently overwritten",
  async () => {
    const data = await privateTemp()
    try {
      const store = Capabilities.store({ data, desktop: true })
      const overlay = await store.overlay()
      const file = path.join(overlay.skills!.paths![0], "using-superpowers/SKILL.md")
      await fs.writeFile(file, "user modification")
      await expect(store.overlay()).rejects.toThrow("Capability state is unavailable")
      expect(await fs.readFile(file, "utf8")).toBe("user modification")
    } finally {
      await fs.rm(data, { recursive: true, force: true })
    }
  },
  timeout,
)

test.skipIf(process.platform === "win32")("state links and broad POSIX permissions fail closed", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
  try {
    const store = Capabilities.store({ data, desktop: false })
    await store.change("github", "enable")
    const file = path.join(data, "bharatcode-capabilities.json")
    const other = path.join(data, "other.json")
    await fs.link(file, other)
    await expect(store.read()).rejects.toThrow("Capability state is unavailable")
    await fs.unlink(other)
    await fs.chmod(file, 0o644)
    await expect(store.change("github", "disable")).rejects.toThrow("Capability state is unavailable")
    await fs.chmod(file, 0o600)
    await fs.rename(file, other)
    await fs.symlink(other, file)
    await expect(store.read()).rejects.toThrow("Capability state is unavailable")
  } finally {
    await fs.rm(data, { recursive: true, force: true })
  }
})
