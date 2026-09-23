import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Capabilities } from "../src/capabilities"

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
