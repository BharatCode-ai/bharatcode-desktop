import { describe, expect, test } from "bun:test"
import { lstat, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  captureMigrationSource,
  verifyCapturedSnapshot,
  verifyCapturedSource,
  type MigrationDestination,
} from "@/migration/capture"
import { Database } from "bun:sqlite"
import type { MigrationSource } from "@/migration/source"
import { tmpdir } from "../fixture/fixture"

describe("migration capture", () => {
  test("seals stable sanitized bytes independent of enumeration order and preserves source", async () => {
    await using tmp = await tmpdir()
    const source = await fixture(tmp.path, ["z.json", "a.json"])
    const destination = target(tmp.path)
    const before = await readFile(path.join(source.roots.config!, "a.json"))

    const first = await captureMigrationSource(source, destination)
    const secondSource = await fixture(path.join(tmp.path, "second"), ["a.json", "z.json"])
    const second = await captureMigrationSource(secondSource, target(path.join(tmp.path, "second")))

    expect(first.contentFingerprint).toBe(second.contentFingerprint)
    expect(first.snapshotDigest).toBe(second.snapshotDigest)
    expect(first.records).toBe(2)
    expect(await verifyCapturedSource({ captured: first, source })).toBe(true)
    expect(await readFile(path.join(source.roots.config!, "a.json"))).toEqual(before)
    expect(await Bun.file(path.join(first.snapshotDirectory, "manifest.json")).text()).not.toContain("opencode.ai")
  })

  test("detects a changed live source without mixing it into the sealed snapshot", async () => {
    await using tmp = await tmpdir()
    const source = await fixture(tmp.path, ["config.json"])
    const captured = await captureMigrationSource(source, target(tmp.path))
    await writeFile(path.join(source.roots.config!, "config.json"), JSON.stringify({ theme: "changed" }))

    expect(await verifyCapturedSource({ captured, source })).toBe(false)
    expect(await Bun.file(path.join(captured.snapshotDirectory, "records", "config", "config.json")).text()).toContain(
      "dark",
    )
  })

  test("rejects links, unreadable entries, and bounded-budget overflow", async () => {
    await using tmp = await tmpdir()
    const source = await fixture(tmp.path, [])
    const external = path.join(tmp.path, "outside.json")
    await writeFile(external, "{}")
    await symlink(external, path.join(source.roots.config!, "linked.json"))
    await expect(captureMigrationSource(source, target(tmp.path))).rejects.toThrow("link")

    await using large = await tmpdir()
    const largeSource = await fixture(large.path, [])
    const oversized = path.join(largeSource.roots.config!, "oversized.json")
    await writeFile(oversized, "{}")
    await truncate(oversized, 16 * 1024 * 1024 + 1)
    await expect(captureMigrationSource(largeSource, target(large.path))).rejects.toThrow("budget")
  })

  test("uses private snapshot directories and regular files", async () => {
    await using tmp = await tmpdir()
    const captured = await captureMigrationSource(await fixture(tmp.path, ["config.json"]), target(tmp.path))
    expect((await lstat(captured.snapshotDirectory)).mode & 0o777).toBe(0o700)
    expect((await lstat(path.join(captured.snapshotDirectory, "manifest.json"))).mode & 0o777).toBe(0o600)
  })

  test("retains standalone message/part records, parses JSONC, and captures WAL into one canonical database", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "legacy-config")
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(path.join(data, "storage", "message", "ses_1"), { recursive: true })
    await mkdir(path.join(data, "storage", "part", "msg_1"), { recursive: true })
    await mkdir(config, { recursive: true })
    await writeFile(
      path.join(config, "opencode.jsonc"),
      '{ // retained comment\n "theme": "dark", "$schema": "https://opencode.ai/config.json", }',
    )
    await writeFile(
      path.join(data, "storage", "message", "ses_1", "msg_1.json"),
      JSON.stringify({ id: "msg_1", sessionID: "ses_1", role: "assistant", text: "retained" }),
    )
    await writeFile(
      path.join(data, "storage", "part", "msg_1", "prt_1.json"),
      JSON.stringify({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "answer" }),
    )
    const legacyDatabase = path.join(data, "opencode.db")
    const writer = new Database(legacyDatabase, { create: true })
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    writer.run("CREATE TABLE account(id TEXT PRIMARY KEY, token TEXT)")
    writer.run("INSERT INTO session VALUES ('ses_1', 'kept', 'opencode/coder')")
    writer.run("INSERT INTO account VALUES ('acct_1', 'secret')")
    const source: MigrationSource = {
      id: "wal-source",
      label: "Existing BharatCode data · opencode-cli · 00000000",
      kind: "opencode-cli",
      roots: { config, data },
    }
    const captured = await captureMigrationSource(source, target(tmp.path))
    writer.close()

    expect(await Bun.file(path.join(captured.snapshotDirectory, "records", "config", "opencode.jsonc")).text()).toBe(
      '{"theme":"dark"}',
    )
    expect(
      await Bun.file(
        path.join(captured.snapshotDirectory, "records", "data", "storage", "message", "ses_1", "msg_1.json"),
      ).text(),
    ).toContain("retained")
    expect(
      await Bun.file(
        path.join(captured.snapshotDirectory, "records", "data", "storage", "part", "msg_1", "prt_1.json"),
      ).text(),
    ).toContain("answer")
    const sealed = new Database(path.join(captured.snapshotDirectory, "records", "database", "main.sqlite"), {
      readonly: true,
    })
    expect(sealed.query("SELECT title, model FROM session").get()).toEqual({ title: "kept", model: null })
    expect(() => sealed.query("SELECT * FROM account").all()).toThrow()
    sealed.close()
  })

  test("rejects every unmanifested snapshot entry", async () => {
    await using tmp = await tmpdir()
    const captured = await captureMigrationSource(await fixture(tmp.path, ["config.json"]), target(tmp.path))
    await writeFile(path.join(captured.snapshotDirectory, "records", "config", "foreign.json"), "{}")
    expect(
      await verifyCapturedSnapshot({
        snapshotDirectory: captured.snapshotDirectory,
        snapshotDigest: captured.snapshotDigest,
        contentFingerprint: captured.contentFingerprint,
      }),
    ).toBe(false)
  })
})

async function fixture(root: string, names: readonly string[]): Promise<MigrationSource> {
  const config = path.join(root, "legacy-config")
  await mkdir(config, { recursive: true })
  for (const name of names) {
    await writeFile(
      path.join(config, name),
      JSON.stringify({ theme: "dark", $schema: "https://opencode.ai/config.json", provider: "opencode" }),
    )
  }
  return {
    id: "opencode-cli-fixture",
    label: "Existing BharatCode data · opencode-cli · 00000000",
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
