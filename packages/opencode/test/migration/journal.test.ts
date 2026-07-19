import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  advanceMigrationJournal,
  canAdvanceMigrationJournal,
  readMigrationJournal,
  type MigrationJournal,
} from "@/migration/journal"
import { tmpdir } from "../fixture/fixture"

describe("migration journal", () => {
  test("accepts only the closed phase graph and exact expected state", async () => {
    await using tmp = await tmpdir()
    const captured = journal("captured")
    expect(canAdvanceMigrationJournal("captured", "prepared")).toBe(true)
    expect(canAdvanceMigrationJournal("prepared", "complete")).toBe(false)
    await advanceMigrationJournal({ stateRoot: tmp.path, expected: undefined, next: captured })
    await expect(
      advanceMigrationJournal({ stateRoot: tmp.path, expected: undefined, next: { ...captured, phase: "prepared" } }),
    ).rejects.toThrow("changed")
    const prepared = await advanceMigrationJournal({
      stateRoot: tmp.path,
      expected: captured,
      next: { ...captured, phase: "prepared" },
    })
    expect((await readMigrationJournal(tmp.path))?.phase).toBe("prepared")
    expect(prepared.phase).toBe("prepared")
  })

  test.each([
    [{ ...journal("captured"), extra: true }, "unknown"],
    [{ ...journal("captured"), phase: "impossible" }, "phase"],
    [{ ...journal("captured"), artifacts: ["a", "a"] }, "duplicate"],
    [{ ...journal("captured"), snapshotDigest: "short" }, "invalid"],
  ])("rejects invalid journal input", async (value, message) => {
    await using tmp = await tmpdir()
    await mkdir(tmp.path, { recursive: true })
    await writeFile(path.join(tmp.path, "lean-migration-v1.json"), JSON.stringify(value))
    await expect(readMigrationJournal(tmp.path)).rejects.toThrow(message)
  })

  test("rejects oversized and malformed durable bytes", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "lean-migration-v1.json")
    await writeFile(file, "{")
    await expect(readMigrationJournal(tmp.path)).rejects.toThrow("invalid")
    await writeFile(file, "x".repeat(65_537))
    await expect(readMigrationJournal(tmp.path)).rejects.toThrow("large")
  })
})

function journal(phase: MigrationJournal["phase"]): MigrationJournal {
  return {
    version: 1,
    operationID: "01234567-89ab-4cde-8fab-0123456789ab",
    phase,
    sourceID: "opencode-cli-" + "a".repeat(64),
    contentFingerprint: "b".repeat(64),
    snapshotDigest: "c".repeat(64),
    destinationFingerprint: "d".repeat(64),
    artifacts: ["snapshot/manifest.json"],
  }
}
