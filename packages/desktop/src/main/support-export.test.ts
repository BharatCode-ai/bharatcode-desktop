import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js"
import { createSupportExporter, supportExportAction } from "./support-export"

async function contents(filename: string) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(filename))))
  try {
    const entries = await reader.getEntries()
    expect(entries.map((entry) => entry.filename)).toEqual(["support-bundle.json"])
    const entry = entries[0]
    if (entry.directory) throw new Error("Expected diagnostic document")
    return await entry.getData!(new TextWriter())
  } finally { await reader.close() }
}

test("actual exported archive excludes private neighboring files and hostile metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-export-"))
  try {
    const secrets = ["sk-api-private-123", "oauth-access-private", "oauth-refresh-private", "owner@private.test", "raw private prompt", "https://github.com/private/repo", "eyJhbGciOiJIUzI1NiJ9.private.signature"]
    for (const name of ["logs", "Crashpad", "config", "chats"]) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, "private.txt"), secrets.join("\n"))
    }
    const reveals: string[] = []
    const run = createSupportExporter({ directory: () => root, input: () => ({ version: "1.2.3", channel: "beta", platform: "linux", auth: { state: "signed_in", authenticated: true, email: secrets[3], token: secrets[0] }, config: { directory: true, authStore: true }, private: secrets }), reveal: (file) => { reveals.push(file) }, failure: () => new Error("safe failure") })
    const file = await run()
    expect(file).toContain("bharatcode-support-")
    expect(reveals).toEqual([file])
    const text = await contents(file)
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(text).not.toContain(root)
    expect(JSON.parse(text)).toMatchObject({ version: "1.2.3", channel: "beta", config: { directory: true, authStore: true }, auth: { state: "signed_in", authenticated: true } })
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).some((file) => file.endsWith(".tmp"))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("coalesces concurrent requests and still saves when metadata or reveal fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-export-"))
  try {
    const ready = Promise.withResolvers<Record<string, unknown>>()
    const run = createSupportExporter({ directory: () => root, input: () => ready.promise, reveal: () => { throw new Error("private reveal error") }, failure: () => new Error("safe failure") })
    const one = run()
    expect(run()).toBe(one)
    ready.reject(new Error("private metadata error"))
    const file = await one
    expect(JSON.parse(await contents(file)).auth.state).toBe("unknown")
    expect(await run()).not.toBe(file)
    expect(await readdir(root)).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("write failure has safe error, no partial file, and allows retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-export-"))
  try {
    let target = join(root, "missing")
    const run = createSupportExporter({ directory: () => target, input: () => ({}), reveal: () => {}, failure: () => new Error("safe failure") })
    await expect(run()).rejects.toThrow("safe failure")
    expect(await readdir(root)).toEqual([])
    target = root
    expect(await contents(await run())).toContain('"formatVersion": 1')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("IPC checks owned main-frame before requesting any export and hides action failures", async () => {
  let calls = 0
  const mainFrame = {}
  const action = supportExportAction({ owned: (id) => id === 1, run: async () => { calls++; throw new Error("private/path/token") }, failure: () => new Error("safe failure") })
  for (const event of [{ sender: { id: 2, mainFrame }, senderFrame: mainFrame }, { sender: { id: 1, mainFrame }, senderFrame: {} }]) {
    await expect(action(event)).rejects.toThrow("safe failure")
  }
  expect(calls).toBe(0)
  await expect(action({ sender: { id: 1, mainFrame }, senderFrame: mainFrame })).rejects.toThrow("safe failure")
  expect(calls).toBe(1)
})
