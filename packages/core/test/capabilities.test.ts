import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Capabilities } from "../src/capabilities"

test("native Desktop imports only its own previous store, once, without changing source bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("missing legacy source is harmless; malformed, linked and writable sources fail without publication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
    await fs.chmod(file, 0o666)
    await expect(Capabilities.migrateDesktop({ data, userData })).rejects.toThrow("Capability state is unavailable")
    await fs.chmod(file, 0o600)
    const original = path.join(userData, "original")
    await fs.rename(file, original)
    await fs.symlink(original, file)
    await expect(Capabilities.migrateDesktop({ data, userData })).rejects.toThrow("Capability state is unavailable")
    await expect(fs.stat(path.join(data, "bharatcode-capabilities.json"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("legacy choices migrate once, retaining disabled defaults and new choices on retry", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("migration retires only exact old managed settings, without modifying caller data", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("invalid legacy records fail closed without publishing a partial migration", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("marketplace changes survive restart without editing runtime configuration", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("independent runtime roots and concurrent capability changes do not overwrite each other", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("Desktop defaults materialize the exact bundled skills; disabling survives restart", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

test("malformed state fails closed and does not get overwritten", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
  try {
    const file = path.join(data, "bharatcode-capabilities.json")
    await fs.writeFile(file, "{invalid", { mode: 0o600 })
    const store = Capabilities.store({ data, desktop: true })
    await expect(store.change("github", "enable")).rejects.toThrow("Capability state is unavailable")
    expect(await fs.readFile(file, "utf8")).toBe("{invalid")
  } finally {
    await fs.rm(data, { recursive: true, force: true })
  }
})

test("altered bundled files are preserved and rejected, never silently overwritten", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bc-capability-"))
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
})

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
