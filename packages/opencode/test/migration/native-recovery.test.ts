import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { captureMigrationSource, fingerprintMigrationSource } from "../../src/migration/capture"
import { activateMigration, prepareMigration, startFresh } from "../../src/migration/cutover"
import { advanceMigrationJournal, readMigrationJournal } from "../../src/migration/journal"
import { renameDurable, writeNewDurable } from "../../src/migration/durable-fs"
import * as durable from "../../src/migration/durable-fs"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bc-native-recovery-"))
  roots.push(root)
  const data = path.join(root, "data")
  const destination = {
    data,
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    database: path.join(data, "bharatcode.db"),
    storage: path.join(data, "storage"),
  }
  return { root, destination }
}
async function source(root: string, id: string, text: string) {
  const config = path.join(root, id)
  await mkdir(config)
  await writeFile(path.join(config, "settings.json"), text)
  return { id, label: id, kind: "bharatcode-current" as const, roots: { config } }
}

test("native Start Fresh publishes a complete journal", async () => {
  const { destination } = await fixture()
  expect(await startFresh({ destination, reason: "no-source", confirmed: true })).toEqual({ state: "fresh" })
  expect((await readMigrationJournal(destination.state))?.phase).toBe("complete")
})

test("choosing a valid source never parses a rejected unrelated peer", async () => {
  const { root, destination } = await fixture()
  const good = await source(root, "good", '{"theme":"dark"}')
  const bad = await source(root, "bad", "INVALID_SYNTHETIC_JSON")
  const choice = { id: good.id, contentFingerprint: await fingerprintMigrationSource(good) }
  const prepared = await prepareMigration({ destination, sources: [bad, good], choice })
  expect(prepared.type).toBe("prepared")
  if (prepared.type !== "prepared") throw new Error("Expected prepared")
  await activateMigration({ destination, operationID: prepared.operationID })
  expect(await readFile(path.join(good.roots.config, "settings.json"), "utf8")).toBe('{"theme":"dark"}')
  expect(await readFile(path.join(destination.config, "settings.json"), "utf8")).toContain("dark")
})

test("an invalid explicitly selected source cannot be replaced silently by a valid peer", async () => {
  const { root, destination } = await fixture()
  const good = await source(root, "good", "{}")
  const bad = await source(root, "bad", "INVALID_SYNTHETIC_JSON")
  await expect(
    prepareMigration({
      destination,
      sources: [good, bad],
      choice: { id: bad.id, contentFingerprint: "a".repeat(64) },
    }),
  ).rejects.toThrow()
  expect(await readMigrationJournal(destination.state)).toBeUndefined()
})

test("retry resumes an interrupted starting-fresh journal without requiring a snapshot", async () => {
  const { destination } = await fixture()
  for (const dir of [destination.data, destination.config, destination.state, destination.storage])
    await mkdir(dir, { recursive: true })
  const journal = {
    version: 1 as const,
    operationID: randomUUID(),
    phase: "starting-fresh" as const,
    sourceID: "start-fresh",
    contentFingerprint: "0".repeat(64),
    snapshotDigest: "0".repeat(64),
    destinationFingerprint: createHash("sha256")
      .update(
        [destination.data, destination.config, destination.state, destination.database, destination.storage]
          .map((item) => path.resolve(item))
          .join("\0"),
      )
      .digest("hex"),
    artifacts: [],
  }
  await advanceMigrationJournal({ stateRoot: destination.state, expected: undefined, next: journal })
  expect(await activateMigration({ destination, operationID: journal.operationID })).toEqual({
    state: "complete",
    sourceID: "start-fresh",
  })
  expect((await readMigrationJournal(destination.state))?.phase).toBe("complete")
})

test("retry resumes after the captured journal was durable but prepared was interrupted", async () => {
  const { root, destination } = await fixture()
  const good = await source(root, "good", '{"theme":"dark"}')
  const captured = await captureMigrationSource(good, destination)
  const journal = {
    version: 1 as const,
    operationID: randomUUID(),
    phase: "captured" as const,
    sourceID: good.id,
    contentFingerprint: captured.contentFingerprint,
    snapshotDigest: captured.snapshotDigest,
    destinationFingerprint: createHash("sha256")
      .update(
        [destination.data, destination.config, destination.state, destination.database, destination.storage]
          .map((item) => path.resolve(item))
          .join("\0"),
      )
      .digest("hex"),
    artifacts: [`migration-snapshots/${captured.snapshotDigest}`],
  }
  await advanceMigrationJournal({ stateRoot: destination.state, expected: undefined, next: journal })
  expect(await activateMigration({ destination, operationID: journal.operationID })).toEqual({
    state: "complete",
    sourceID: good.id,
  })
})

test("durable publication is exclusive unless replacement is explicitly requested", async () => {
  const { root } = await fixture()
  const from = path.join(root, "from")
  const to = path.join(root, "to")
  await writeNewDurable(from, "new")
  await writeNewDurable(to, "old")
  await expect(renameDurable(from, to)).rejects.toThrow()
  expect(await readFile(from, "utf8")).toBe("new")
  expect(await readFile(to, "utf8")).toBe("old")
  await renameDurable(from, to, true)
  expect(await readFile(to, "utf8")).toBe("new")
  await expect(renameDurable(from, path.join(root, "missing"))).rejects.toThrow()
})

test("capture retry reuses only a verified sealed snapshot", async () => {
  const { root, destination } = await fixture()
  const good = await source(root, "good", '{"theme":"dark"}')
  const first = await captureMigrationSource(good, destination)
  expect((await captureMigrationSource(good, destination)).snapshotDigest).toBe(first.snapshotDigest)
  await writeFile(path.join(first.snapshotDirectory, "manifest.json"), "{}")
  await expect(captureMigrationSource(good, destination)).rejects.toThrow()
  expect(await readFile(path.join(good.roots.config, "settings.json"), "utf8")).toBe('{"theme":"dark"}')
})

test.skipIf(process.platform !== "win32")(
  "native sharing violation keeps the previous journal durable and retry succeeds",
  async () => {
    const { root, destination } = await fixture()
    const good = await source(root, "good", "{}")
    await prepareMigration({ destination, sources: [good] })
    const journal = (await readMigrationJournal(destination.state))!
    const unlock = await denyDelete(path.join(destination.state, "lean-migration-v1.json"))
    try {
      await expect(
        advanceMigrationJournal({
          stateRoot: destination.state,
          expected: journal,
          next: { ...journal, phase: "activated" },
        }),
      ).rejects.toThrow("durably publish")
      expect(await readMigrationJournal(destination.state)).toEqual(journal)
    } finally {
      unlock()
    }
    expect(await activateMigration({ destination, operationID: journal.operationID })).toEqual({
      state: "complete",
      sourceID: good.id,
    })
  },
)

test.skipIf(process.platform !== "win32")(
  "native interrupted quarantine retains inventory and all partial data across Start Fresh retry",
  async () => {
    const { destination } = await fixture()
    await mkdir(destination.data, { recursive: true })
    await mkdir(destination.config, { recursive: true })
    await writeFile(path.join(destination.data, "partial.json"), "data-partial")
    const locked = path.join(destination.config, "partial.json")
    await writeFile(locked, "config-partial")
    const unlock = await denyDelete(locked)
    try {
      await expect(startFresh({ destination, reason: "interrupted", confirmed: true })).rejects.toThrow()
      expect(await readMigrationJournal(destination.state)).toBeUndefined()
    } finally {
      unlock()
    }
    expect((await startFresh({ destination, reason: "interrupted", confirmed: true })).state).toBe("fresh")
    const quarantine = path.join(destination.state, "migration-quarantine")
    const files = (await readdir(quarantine, { recursive: true })).filter((file) => file.endsWith(".json"))
    const contents = await Promise.all(files.map((file) => readFile(path.join(quarantine, file), "utf8")))
    expect(contents).toContain("data-partial")
    expect(contents).toContain("config-partial")
    expect(files.filter((file) => file.endsWith("manifest.json"))).toHaveLength(2)
  },
)

async function denyDelete(file: string) {
  const { dlopen, ptr } = await import("bun:ffi")
  const library = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  })
  const bytes = Buffer.from(path.toNamespacedPath(file) + "\0", "utf16le")
  const handle = library.symbols.CreateFileW(ptr(bytes), 0x80000000, 3, null, 3, 0x80, null)
  if (!handle || Number(handle) === -1 || Number(handle) > Number.MAX_SAFE_INTEGER)
    throw new Error("Native failure fixture could not pin its file")
  return () => {
    library.symbols.CloseHandle(handle)
    library.close()
  }
}

test.each(["unchanged", "altered", "unexpected"] as const)(
  "mid-role publication retry handles an %s partial destination without losing source/snapshot",
  async (kind) => {
    const { root, destination } = await fixture()
    const data = path.join(root, "legacy-data")
    await mkdir(data)
    await writeFile(path.join(data, "a.txt"), "first retained record")
    await writeFile(path.join(data, "b.txt"), "second retained record")
    const candidate = {
      id: "data-source",
      label: "Existing data",
      kind: "bharatcode-current" as const,
      roots: { data },
    }
    const prepared = await prepareMigration({ destination, sources: [candidate] })
    if (prepared.type !== "prepared") throw new Error("Expected prepared")
    const journal = (await readMigrationJournal(destination.state))!
    const manifest = path.join(destination.state, "migration-snapshots", journal.snapshotDigest, "manifest.json")
    const sealed = await readFile(manifest)
    const move = durable.renameDurable
    const injected = spyOn(durable, "renameDurable").mockImplementation(async (from, to, replace) => {
      if (to === path.join(destination.data, "b.txt"))
        throw new Error("Injected interruption after first durable role publication")
      return move(from, to, replace)
    })
    try {
      await expect(activateMigration({ destination, operationID: prepared.operationID })).rejects.toThrow("Injected")
    } finally {
      injected.mockRestore()
    }
    expect(await readFile(path.join(destination.data, "a.txt"), "utf8")).toBe("first retained record")
    expect((await readMigrationJournal(destination.state))?.phase).toBe("prepared")
    if (kind === "altered") await writeFile(path.join(destination.data, "a.txt"), "unreviewed change")
    if (kind === "unexpected") await writeFile(path.join(destination.data, "extra.txt"), "unreviewed addition")
    if (kind === "unchanged") {
      expect(await activateMigration({ destination, operationID: prepared.operationID })).toEqual({
        state: "complete",
        sourceID: candidate.id,
      })
      expect(await readFile(path.join(destination.data, "b.txt"), "utf8")).toBe("second retained record")
    } else {
      await expect(activateMigration({ destination, operationID: prepared.operationID })).rejects.toThrow(
        "destination changed",
      )
      expect((await readdir(destination.data)).includes("b.txt")).toBe(false)
    }
    expect(await readFile(manifest)).toEqual(sealed)
    expect(await readFile(path.join(data, "a.txt"), "utf8")).toBe("first retained record")
    expect(await readFile(path.join(data, "b.txt"), "utf8")).toBe("second retained record")
  },
)
