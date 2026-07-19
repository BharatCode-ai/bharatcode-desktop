import { describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

import { fingerprintMigrationSource, type MigrationDestination } from "@/migration/capture"
import {
  activateMigration,
  prepareMigration,
  startFresh,
  validateFreshDestination,
} from "@/migration/cutover"
import type { MigrationSource } from "@/migration/source"
import { tmpdir } from "../fixture/fixture"

describe("migration cutover", () => {
  test("returns closed actions for zero and ambiguous sources", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    expect(await prepareMigration({ sources: [], destination })).toEqual({
      type: "start-fresh",
      reason: "no-source",
    })
    const first = await source(tmp.path, "first")
    const second = await source(tmp.path, "second")
    const result = await prepareMigration({ sources: [second, first], destination })
    expect(result.type).toBe("choose-source")
    if (result.type !== "choose-source") throw new Error("expected source choice")
    expect(result.sources.map((item) => item.id)).toEqual([first.id, second.id])
    expect(result.sources.every((item) => /^[0-9a-f]{64}$/.test(item.contentFingerprint))).toBe(true)
  })

  test("rejects a stale choice and never mixes newly changed source bytes", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const fingerprint = await fingerprintMigrationSource(candidate)
    await writeFile(path.join(candidate.roots.config!, "settings.json"), JSON.stringify({ theme: "changed" }))
    const result = await prepareMigration({
      sources: [candidate],
      choice: { id: candidate.id, contentFingerprint: fingerprint },
      destination: target(tmp.path),
    })
    expect(result.type).toBe("choose-source")
  })

  test("prepares, activates, validates, completes, and retries idempotently from the sealed snapshot", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const destination = target(tmp.path)
    const prepared = await prepareMigration({ sources: [candidate], destination })
    expect(prepared.type).toBe("prepared")
    if (prepared.type !== "prepared") throw new Error("expected prepared operation")
    const sourceBytes = await readFile(path.join(candidate.roots.config!, "settings.json"))

    const complete = await activateMigration({ operationID: prepared.operationID, destination })
    expect(complete).toEqual({ state: "complete", sourceID: candidate.id })
    expect(await activateMigration({ operationID: prepared.operationID, destination })).toEqual(complete)
    expect(await validateFreshDestination(destination)).toBe(true)
    expect(await readFile(path.join(candidate.roots.config!, "settings.json"))).toEqual(sourceBytes)
    expect(await Bun.file(path.join(destination.config, "settings.json")).text()).not.toContain("opencode.ai")
  })

  test("serializes simultaneous callers on one destination operation", async () => {
    await using tmp = await tmpdir()
    const candidate = await source(tmp.path, "legacy")
    const destination = target(tmp.path)
    const results = await Promise.all([
      prepareMigration({ sources: [candidate], destination }),
      prepareMigration({ sources: [candidate], destination }),
    ])
    expect(results.filter((item) => item.type === "prepared")).toHaveLength(1)
    expect(results.filter((item) => item.type === "retry")).toHaveLength(1)
  })

  test("Start Fresh is marker-independent, quarantines known partials, and preserves every source", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    const candidate = await source(tmp.path, "legacy")
    await mkdir(destination.storage, { recursive: true })
    await writeFile(destination.database, "partial-db")
    await writeFile(path.join(destination.storage, "partial.json"), "partial")
    await mkdir(destination.config, { recursive: true })
    await writeFile(path.join(destination.config, "partial.json"), "partial")
    const sourceBytes = await readFile(path.join(candidate.roots.config!, "settings.json"))

    const result = await startFresh({ destination, reason: "interrupted", confirmed: true })
    expect(result.state).toBe("fresh")
    expect(result.quarantine).toBeString()
    expect(await validateFreshDestination(destination)).toBe(true)
    expect(await readFile(path.join(candidate.roots.config!, "settings.json"))).toEqual(sourceBytes)
    await expect(startFresh({ destination, reason: "interrupted", confirmed: true })).rejects.toThrow("healthy")
  })

  test("fails closed for linked, conflicting, and healthy completed destinations", async () => {
    await using tmp = await tmpdir()
    const destination = target(tmp.path)
    const outside = path.join(tmp.path, "outside")
    await mkdir(outside)
    await mkdir(path.dirname(destination.config), { recursive: true })
    await symlink(outside, destination.config)
    await expect(startFresh({ destination, reason: "interrupted", confirmed: true })).rejects.toThrow("link")

    const conflict = target(path.join(tmp.path, "conflict"))
    conflict.config = conflict.data
    await expect(startFresh({ destination: conflict, reason: "interrupted", confirmed: true })).rejects.toThrow(
      "overlap",
    )
  })
})

async function source(root: string, id: string): Promise<MigrationSource> {
  const config = path.join(root, `source-${id}`)
  await mkdir(config, { recursive: true })
  await writeFile(
    path.join(config, "settings.json"),
    JSON.stringify({ theme: "dark", $schema: "https://opencode.ai/config.json" }),
  )
  return {
    id,
    label: `Existing BharatCode data · opencode-cli · ${id.padEnd(8, "0").slice(0, 8)}`,
    kind: "opencode-cli",
    roots: { config },
  }
}

function target(root: string): MigrationDestination {
  return {
    data: path.join(root, "destination", "data"),
    config: path.join(root, "destination", "config"),
    state: path.join(root, "destination", "state"),
    database: path.join(root, "destination", "data", "bharatcode.db"),
    storage: path.join(root, "destination", "data", "storage"),
  }
}
