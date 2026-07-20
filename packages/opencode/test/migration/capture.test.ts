import { describe, expect, test } from "bun:test"
import { lstat, mkdir, readFile, readdir, symlink, truncate, writeFile } from "node:fs/promises"
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
    writer.run("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("CREATE TABLE account(id TEXT PRIMARY KEY, token TEXT)")
    writer.run("INSERT INTO session VALUES ('ses_1', 'kept', 'opencode/coder')")
    writer.run(
      'INSERT INTO message VALUES (\'msg_1\', \'{"role":"assistant","text":"Harmless discussion: opencode serve uses https://opencode.ai"}\')',
    )
    writer.run(
      'INSERT INTO part VALUES (\'prt_1\', \'{"type":"text","text":"Transcript mentions opencode serve and https://opencode.ai"}\')',
    )
    writer.run(
      'INSERT INTO permission VALUES (\'project_1\', \'{"command":"opencode serve","url":"https://opencode.ai"}\')',
    )
    writer.run("INSERT INTO account VALUES ('acct_1', 'secret')")
    const source: MigrationSource = {
      id: "wal-source",
      label: "Existing BharatCode data · opencode-cli · 00000000",
      kind: "opencode-cli",
      roots: { config, data },
    }
    const captured = await captureMigrationSource(source, target(tmp.path))
    writer.close()

    expect(await Bun.file(path.join(captured.snapshotDirectory, "records", "config", "bharatcode.jsonc")).text()).toBe(
      '{"theme":"dark"}',
    )
    expect(await Bun.file(path.join(captured.snapshotDirectory, "records", "config", "opencode.jsonc")).exists()).toBe(
      false,
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
    expect(sealed.query("SELECT data FROM message").get()).toEqual({
      data: '{"role":"assistant","text":"Harmless discussion: opencode serve uses https://opencode.ai"}',
    })
    expect(sealed.query("SELECT data FROM part").get()).toEqual({
      data: '{"type":"text","text":"Transcript mentions opencode serve and https://opencode.ai"}',
    })
    expect(sealed.query("SELECT count(*) AS count FROM permission").get()).toEqual({ count: 0 })
    expect(() => sealed.query("SELECT * FROM account").all()).toThrow()
    sealed.close()
  })

  test("physically removes every sanitized capability byte from a pinned-beta SQLite snapshot", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const legacyDatabase = path.join(data, "opencode.db")
    const writer = new Database(legacyDatabase, { create: true })
    writer.run("PRAGMA journal_mode = WAL")
    await applyPinnedBetaSchema(writer)
    const secrets = {
      accountAccess: sentinel("account-access", 7),
      accountRefresh: sentinel("account-refresh", 79),
      controlAccess: sentinel("control-access", 19),
      controlRefresh: sentinel("control-refresh", 131),
      shareSecret: sentinel("share-secret", 11),
      shareUrl: sentinel("share-url", 67),
      projectCommands: sentinel("project-commands", 23),
      projectIcon: sentinel("project-icon", 71),
      projectOverride: sentinel("project-override", 29),
      sessionShare: sentinel("session-share", 73),
      sessionPermission: sentinel("session-permission", 31),
      sessionAgent: sentinel("session-agent", 83),
      sessionModel: sentinel("session-model", 37),
      workspaceExtra: sentinel("workspace-extra", 89),
      permissionData: sentinel("permission-data", 41),
      eventData: sentinel("event-data", 97),
      eventOwner: sentinel("event-owner", 43),
      migrationName: sentinel("migration-name", 101),
      messageProvider: sentinel("message-provider", 47),
      partCommand: sentinel("part-command", 103),
    }
    writer.run(
      "INSERT INTO project (id, worktree, name, icon_url, icon_url_override, time_created, time_updated, sandboxes, commands) VALUES (?, ?, ?, ?, ?, 1, 1, '[]', ?)",
      [
        "project_1",
        "/workspace/project",
        "retained project",
        secrets.projectIcon,
        secrets.projectOverride,
        secrets.projectCommands,
      ],
    )
    writer.run(
      "INSERT INTO workspace (id, type, name, extra, project_id, time_used) VALUES (?, 'local', 'retained workspace', ?, ?, 1)",
      ["workspace_1", secrets.workspaceExtra, "project_1"],
    )
    writer.run(
      "INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, share_url, permission, agent, model, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, 'slug', '/workspace/project', 'retained session', '1', ?, ?, ?, ?, 1, 1, 0, 0, 0, 0, 0, 0)",
      [
        "session_1",
        "project_1",
        "workspace_1",
        secrets.sessionShare,
        secrets.sessionPermission,
        secrets.sessionAgent,
        secrets.sessionModel,
      ],
    )
    writer.run("INSERT INTO account VALUES (?, ?, ?, ?, ?, NULL, 1, 1)", [
      "account_1",
      "account@example.test",
      "https://account.invalid",
      secrets.accountAccess,
      secrets.accountRefresh,
    ])
    writer.run("INSERT INTO account_state VALUES (1, ?, NULL)", ["account_1"])
    writer.run("INSERT INTO control_account VALUES (?, ?, ?, ?, NULL, 1, 1, 1)", [
      "control@example.test",
      "https://control.invalid",
      secrets.controlAccess,
      secrets.controlRefresh,
    ])
    writer.run("INSERT INTO session_share VALUES (?, 'share_1', ?, ?, 1, 1)", [
      "session_1",
      secrets.shareSecret,
      secrets.shareUrl,
    ])
    writer.run("INSERT INTO permission VALUES (?, 1, 1, ?)", ["project_1", secrets.permissionData])
    writer.run("INSERT INTO event_sequence VALUES ('aggregate_1', 1, ?)", [secrets.eventOwner])
    writer.run("INSERT INTO event VALUES ('event_1', 'aggregate_1', 1, 'capability', ?)", [secrets.eventData])
    writer.run("INSERT INTO data_migration VALUES (?, 1)", [secrets.migrationName])
    writer.run("INSERT INTO message VALUES (?, ?, 1, 1, ?)", [
      "message_1",
      "session_1",
      JSON.stringify({ role: "assistant", text: "retained transcript", provider: secrets.messageProvider }),
    ])
    writer.run("INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)", [
      "part_1",
      "message_1",
      "session_1",
      JSON.stringify({ type: "text", text: "retained answer", command: secrets.partCommand }),
    ])
    const sourceMain = await readFile(legacyDatabase)
    const sourceWal = await readFile(`${legacyDatabase}-wal`)

    const captured = await captureMigrationSource(
      {
        id: "pinned-beta-database",
        label: "Existing BharatCode data · opencode-cli · 00000000",
        kind: "opencode-cli",
        roots: { data },
      },
      target(tmp.path),
    )
    const outputDirectory = path.join(captured.snapshotDirectory, "records", "database")
    expect(await readdir(outputDirectory)).toEqual(["main.sqlite"])
    const output = await readFile(path.join(outputDirectory, "main.sqlite"))
    expect(
      Object.entries(secrets)
        .filter(([, value]) => output.includes(Buffer.from(value)))
        .map(([name]) => name),
    ).toEqual([])
    expect(await readFile(legacyDatabase)).toEqual(sourceMain)
    expect(await readFile(`${legacyDatabase}-wal`)).toEqual(sourceWal)
    writer.close()

    const sealed = new Database(path.join(outputDirectory, "main.sqlite"), { readonly: true })
    expect(sealed.query("SELECT name, commands, icon_url, icon_url_override FROM project").get()).toEqual({
      name: "retained project",
      commands: null,
      icon_url: null,
      icon_url_override: null,
    })
    expect(sealed.query("SELECT title, share_url, permission, agent, model FROM session").get()).toEqual({
      title: "retained session",
      share_url: null,
      permission: null,
      agent: null,
      model: null,
    })
    expect(sealed.query("SELECT data FROM message").get()).toEqual({
      data: '{"role":"assistant","text":"retained transcript"}',
    })
    expect(sealed.query("SELECT data FROM part").get()).toEqual({
      data: '{"type":"text","text":"retained answer"}',
    })
    for (const table of ["account", "account_state", "control_account", "session_share"]) {
      expect(() => sealed.query(`SELECT * FROM ${table}`).all()).toThrow()
    }
    for (const table of ["permission", "event", "event_sequence", "data_migration"]) {
      expect(sealed.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    sealed.close()
  })

  test("fails closed for an unknown SQLite capability location", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE runtime_capability(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    database.run(
      'INSERT INTO runtime_capability VALUES (\'runtime_1\', \'{"command":"opencode serve","url":"https://opencode.ai"}\')',
    )
    database.close()

    await expect(
      captureMigrationSource(
        {
          id: "unknown-capability",
          label: "Existing BharatCode data · opencode-cli · 00000000",
          kind: "opencode-cli",
          roots: { data },
        },
        target(tmp.path),
      ),
    ).rejects.toThrow("unsupported SQLite capability")
  })

  test("fails closed for an unknown capability column on a recognized SQLite table", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, runtime_fallback TEXT)")
    database.run("INSERT INTO session VALUES ('ses_1', 'kept', 'opencode serve https://opencode.ai')")
    database.close()

    await expect(
      captureMigrationSource(
        {
          id: "unknown-column",
          label: "Existing BharatCode data · opencode-cli · 00000000",
          kind: "opencode-cli",
          roots: { data },
        },
        target(tmp.path),
      ),
    ).rejects.toThrow("unsupported SQLite capability")
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

async function applyPinnedBetaSchema(database: Database) {
  database.run('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)')
  for (const name of (await readdir(path.join(import.meta.dir, "../../migration"))).toSorted()) {
    database.run(await readFile(path.join(import.meta.dir, "../../migration", name, "migration.sql"), "utf8"))
  }
}

function sentinel(name: string, size: number) {
  return `CP3-${name}-${"X".repeat(size)}-END`
}
