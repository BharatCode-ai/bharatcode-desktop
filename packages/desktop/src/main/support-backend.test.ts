import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile, symlink, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js"
import { supportEvent, supportEvents } from "@opencode-ai/core/util/support-event"
import { createSupportBackend } from "./support-backend"
import { createSupportExporter } from "./support-export"
import { supportPrivacyCases } from "./test-fixtures/support-privacy"

test("backend diagnostics project only known fields and reject hostile codes, IDs, models and nested data", () => {
  for (const [secret] of supportPrivacyCases) {
    const event = supportEvent({
      time: new Date().toISOString(),
      event: "request_failed",
      code: secret,
      model: secret,
      requestId: secret,
      operationId: secret,
      attempt: secret,
      status: secret,
      retryable: secret,
      message: secret,
      stack: secret,
      headers: { authorization: secret },
      prompt: secret,
    })
    expect(event).toMatchObject({
      event: "request_failed",
      code: null,
      model: "other",
      requestId: null,
      attempt: null,
      status: null,
    })
    expect(JSON.stringify(event)).not.toContain(secret)
  }
  expect(supportEvent({ time: "private", event: "request_failed" })).toBeUndefined()
  expect(supportEvent({ time: new Date().toISOString(), event: "private" })).toBeUndefined()
})

test("backend log survives restart, rejects stale owners, bounds retention, and exports real sanitized events", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-backend-log-"))
  try {
    let now = Date.now()
    const file = join(root, "backend-events.json")
    const first = createSupportBackend(() => now)
    first.configure(file)
    const old = first.attach()
    old.publish({
      event: "request_failed",
      time: new Date(now).toISOString(),
      code: "ECONNRESET",
      attempt: 1,
      message: "PRIVATE-PROMPT",
      headers: { authorization: "PRIVATE-TOKEN" },
      response: "PRIVATE-RESPONSE",
    })
    const owner = first.attach()
    old.publish({ event: "request_failed", time: new Date(now).toISOString(), code: "ENOTFOUND" })
    owner.publish({ event: "retry_scheduled", time: new Date(now).toISOString(), attempt: 1 })
    owner.dispose()
    owner.publish({ event: "request_completed", time: new Date(now).toISOString() })
    expect(first.read()).toHaveLength(2)
    const restarted = createSupportBackend(() => now)
    restarted.configure(file)
    expect(restarted.read()).toEqual(first.read())
    const exportLogs = createSupportExporter({
      directory: () => root,
      input: () => ({ backendEvents: restarted.read() }),
      reveal: () => {},
      failure: () => new Error("export failed"),
    })
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(await exportLogs()))))
    try {
      const entries = await reader.getEntries()
      const eventFile = entries.find((entry) => entry.filename === "backend-events.jsonl")!
      if (eventFile.directory) throw Error("expected event log")
      const text = await eventFile.getData!(new TextWriter())
      const rows = text.split("\n").map((row) => JSON.parse(row))
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ event: "request_failed", code: "ECONNRESET", attempt: 1 })
      expect(text).not.toContain("PRIVATE")
      expect(text).not.toContain(root)
    } finally {
      await reader.close()
    }
    expect(await readFile(file, "utf8")).not.toContain("PRIVATE")
    const live = restarted.attach()
    for (let i = 0; i < 205; i++) live.publish({ event: "request_started", time: new Date(now).toISOString() })
    expect(restarted.read()).toHaveLength(200)
    expect((await stat(file)).size).toBeLessThan(100_000)
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false)
    now += 24 * 60 * 60 * 1000 + 1
    expect(restarted.read()).toHaveLength(0)
    expect(supportEvents([{ event: "request_started", time: new Date(now + 1).toISOString() }], now)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupt, oversized and symlinked archives are ignored; disk failure leaves in-memory diagnostics usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-backend-invalid-"))
  try {
    for (const data of [
      "not JSON",
      "x".repeat(256 * 1024 + 1),
      JSON.stringify([{ event: "request_failed", time: new Date().toISOString(), message: "PRIVATE" }]),
    ]) {
      const file = join(root, "bad.json")
      await writeFile(file, data)
      const store = createSupportBackend()
      store.configure(file)
      expect(JSON.stringify(store.read())).not.toContain("PRIVATE")
    }
    const target = join(root, "target.json")
    await writeFile(
      target,
      JSON.stringify([{ event: "request_failed", time: new Date().toISOString(), code: "ECONNRESET" }]),
    )
    const link = join(root, "link.json")
    await symlink(target, link)
    const store = createSupportBackend()
    store.configure(link)
    expect(store.read()).toEqual([])
    const unavailable = createSupportBackend()
    unavailable.configure(join(root, "missing", "events.json"))
    unavailable.attach().publish({ event: "request_failed", time: new Date().toISOString(), code: "ECONNRESET" })
    expect(unavailable.read()[0].code).toBe("ECONNRESET")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
