import { describe, expect, test } from "bun:test"
import { watch } from "node:fs"
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
    writer.run("INSERT INTO account VALUES ('acct_1', 'legacy-secret-token')")
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
      (await snapshotRecordFiles(captured.snapshotDirectory)).some((file) => /\.db-(?:wal|shm)$/i.test(file)),
    ).toBe(false)
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
    writer.run("INSERT INTO account VALUES (?, ?, ?, ?, ?, 1784518200000, 1, 1)", [
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

  test("excludes associated SQLite sidecars while preserving main and durable sidecar bytes", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const legacyDatabase = path.join(data, "opencode.db")
    const database = new Database(legacyDatabase, { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("INSERT INTO session VALUES ('session_1', 'retained', NULL)")
    database.close()
    const durableSidecars = new Map([
      [`${legacyDatabase}-journal`, Buffer.concat([Buffer.alloc(512), Buffer.from(sentinel("journal-secret", 91))])],
      [`${legacyDatabase}-mjDEADBEEF`, Buffer.from(sentinel("super-journal-secret", 53))],
    ])
    for (const [file, bytes] of durableSidecars) await writeFile(file, bytes)
    const shm = `${legacyDatabase}-shm`
    await writeFile(shm, Buffer.from(sentinel("ephemeral-shm", 37)))
    const sourceMain = await readFile(legacyDatabase)
    const sourceSidecars = await Promise.all([...durableSidecars.keys()].map((file) => readFile(file)))

    const captured = await captureMigrationSource(databaseSource(data, "sidecar-source"), target(tmp.path))

    expect(await snapshotRecordFiles(captured.snapshotDirectory)).toEqual(["database/main.sqlite"])
    expect(await readFile(legacyDatabase)).toEqual(sourceMain)
    expect(await Promise.all([...durableSidecars.keys()].map((file) => readFile(file)))).toEqual(sourceSidecars)
    expect(await Bun.file(shm).exists()).toBe(true)
  })

  test("fails closed for an unexplained database-adjacent sidecar", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.close()
    await writeFile(path.join(data, "opencode.db-journal.foreign"), sentinel("foreign-sidecar", 31))

    await expect(captureMigrationSource(databaseSource(data, "foreign-sidecar"), target(tmp.path))).rejects.toThrow(
      "database-adjacent",
    )
  })

  test.each([
    ["exact", (secret: string) => secret],
    ["substring", (secret: string) => `Retained prefix ${secret} retained suffix`],
  ])("rejects a dropped credential in a retained %s collision", async (_name, title) => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const secret = "Bearer CP3collisiontokenabcdefghijklmnop"
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT, access_token TEXT)")
    database.run("INSERT INTO session VALUES ('session_1', ?, NULL)", [title(secret)])
    database.run("INSERT INTO account VALUES ('account_1', 'owner@example.test', ?)", [secret])
    database.close()

    await expect(
      captureMigrationSource(databaseSource(data, "credential-collision"), target(tmp.path)),
    ).rejects.toThrow("credential bytes")
  })

  test("fails closed for a short explicit credential before collision verification", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("CREATE TABLE account(id TEXT PRIMARY KEY, access_token TEXT)")
    database.run("INSERT INTO session VALUES ('session_1', 'Retained tiny collision', NULL)")
    database.run("INSERT INTO account VALUES ('account_1', 'tiny')")
    database.close()

    await expect(captureMigrationSource(databaseSource(data, "short-credential"), target(tmp.path))).rejects.toThrow(
      "short credential",
    )
  })

  test("rejects nonnumeric legacy token-expiry metadata", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE account(id TEXT PRIMARY KEY, access_token TEXT, token_expiry INTEGER)")
    database.run("INSERT INTO account VALUES ('account_1', 'opaqueAccessTokenValue0123456789', 'hidden-secret')")
    database.close()

    await expect(
      captureMigrationSource(databaseSource(data, "invalid-token-expiry"), target(tmp.path)),
    ).rejects.toThrow("credential metadata")
  })

  test.each([
    [
      "API key",
      { provider: { apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" } },
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "credential bytes",
    ],
    [
      "opaque authorization",
      { provider: { authorization: "opaqueCredentialValue0123456789" } },
      "opaqueCredentialValue0123456789",
      "credential bytes",
    ],
    [
      "nested generic secret",
      { provider: { accounts: [{ metadata: { secret: "opaqueSecretValue0123456789" } }] } },
      "opaqueSecretValue0123456789",
      "credential bytes",
    ],
    ["short key-defined credential", { provider: { apiKey: "tiny" } }, "tiny", "short credential"],
  ])("rejects a retained credential collected from a removed JSON %s path", async (_name, removed, secret, failure) => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    database.run("INSERT INTO message VALUES ('message_1', ?)", [
      JSON.stringify({ role: "assistant", text: `retained ${secret}`, ...removed }),
    ])
    database.close()

    await expect(captureMigrationSource(databaseSource(data, `json-${_name}`), target(tmp.path))).rejects.toThrow(
      failure,
    )
  })

  test.each([
    ["accessTokenValue", "opaqueAccessTokenValue0123456789", (secret: string) => secret],
    ["access-token-value", "opaqueKebabTokenValue0123456789", (secret: string) => `prefix ${secret} suffix`],
    ["authorizationHeader", "opaqueAuthorizationHeaderValue0123456789", (secret: string) => secret],
    ["authorization_header", "opaqueSnakeAuthorizationHeader0123456789", (secret: string) => `prefix ${secret} suffix`],
  ])("rejects a retained opaque credential from the closed %s key grammar", async (key, secret, retained) => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    database.run("INSERT INTO message VALUES ('message_1', ?)", [
      JSON.stringify({ role: "assistant", text: retained(secret), provider: { [key]: secret } }),
    ])
    database.close()

    await expect(
      captureMigrationSource(databaseSource(data, `credential-key-${key}`), target(tmp.path)),
    ).rejects.toThrow("credential bytes")
  })

  test("rejects an opaque authorization removed from permission JSON but retained in a title", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const secret = "opaqueCredentialValue0123456789"
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    database.run("INSERT INTO session VALUES ('session_1', ?, NULL)", [`Retained ${secret}`])
    database.run("INSERT INTO permission VALUES ('project_1', ?)", [JSON.stringify({ authorization: secret })])
    database.close()

    await expect(
      captureMigrationSource(databaseSource(data, "permission-authorization"), target(tmp.path)),
    ).rejects.toThrow("credential bytes")
  })

  test("does not classify benign prose or near-key JSON values as credentials", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    database.run("INSERT INTO message VALUES ('message_1', ?)", [
      JSON.stringify({
        role: "assistant",
        text: "Use a password manager for safety; opaqueNearKeyValue0123456789 is harmless prose",
        passwordHint: "Use a password manager for safety",
        tokenizer: "ordinary tokenizer prose",
        tokenCount: 42,
        commander: "ordinary command prose",
        provider: {
          passwordHint: "opaqueNearKeyValue0123456789",
          tokenizer: "opaqueNearKeyValue0123456789",
          tokenCount: "opaqueNearKeyValue0123456789",
        },
      }),
    ])
    database.close()

    const captured = await captureMigrationSource(databaseSource(data, "benign-json-prose"), target(tmp.path))
    const sealed = new Database(path.join(captured.snapshotDirectory, "records", "database", "main.sqlite"), {
      readonly: true,
    })
    expect(sealed.query("SELECT data FROM message").get()).toEqual({
      data: '{"role":"assistant","text":"Use a password manager for safety; opaqueNearKeyValue0123456789 is harmless prose"}',
    })
    sealed.close()
  })

  test("rejects non-UTF8 bytes discarded from a capability column when retained elsewhere", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88])
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    database.run(
      "CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER, time_created INTEGER, time_updated INTEGER)",
    )
    database.run("INSERT INTO permission VALUES ('project_1', ?)", [bytes])
    database.run("INSERT INTO todo VALUES ('session_1', ?, 'pending', 'high', 1, 1, 1)", [bytes])
    database.close()

    await expect(captureMigrationSource(databaseSource(data, "binary-capability"), target(tmp.path))).rejects.toThrow(
      "credential bytes",
    )
  })

  test.each(["UTF-16le", "UTF-16be"])("rejects a %s SQLite source before credential verification", async (encoding) => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const legacyDatabase = path.join(data, "opencode.db")
    const secret = "Bearer UTF16credentialabcdefghijklmnop"
    const database = new Database(legacyDatabase, { create: true })
    database.run(`PRAGMA encoding = '${encoding}'`)
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("CREATE TABLE account(id TEXT PRIMARY KEY, access_token TEXT)")
    database.run("INSERT INTO session VALUES ('session_1', ?, NULL)", [`Retained ${secret}`])
    database.run("INSERT INTO account VALUES ('account_1', ?)", [secret])
    database.close()
    const sourceMain = await readFile(legacyDatabase)

    await expect(
      captureMigrationSource(databaseSource(data, `encoding-${encoding}`), target(tmp.path)),
    ).rejects.toThrow("UTF-8")
    expect(await readFile(legacyDatabase)).toEqual(sourceMain)
  })

  test("preserves an ordinary retained substring that also appeared in noncredential dropped metadata", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const ordinary = "ordinary-shared-identifier"
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT, access_token TEXT)")
    database.run("INSERT INTO session VALUES ('session_1', ?, NULL)", [`Retained prefix ${ordinary} retained suffix`])
    database.run("INSERT INTO account VALUES ('account_1', ?, 'short-token')", [ordinary])
    database.close()

    const captured = await captureMigrationSource(databaseSource(data, "ordinary-collision"), target(tmp.path))
    const sealed = new Database(path.join(captured.snapshotDirectory, "records", "database", "main.sqlite"), {
      readonly: true,
    })
    expect(sealed.query("SELECT title FROM session").get()).toEqual({
      title: `Retained prefix ${ordinary} retained suffix`,
    })
    sealed.close()
  })

  test("bounds verification work for five thousand removed and retained rows", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    await mkdir(data, { recursive: true })
    const database = new Database(path.join(data, "opencode.db"), { create: true })
    database.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    database.run("CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT, access_token TEXT)")
    const insertSession = database.prepare("INSERT INTO session VALUES (?, ?, NULL)")
    const insertAccount = database.prepare("INSERT INTO account VALUES (?, ?, ?)")
    database.transaction(() => {
      for (let index = 0; index < 5_000; index++) {
        const suffix = index.toString().padStart(5, "0")
        insertSession.run(`session_${suffix}`, `Retained ordinary transcript ${suffix}`)
        insertAccount.run(
          `account_${suffix}`,
          `owner-${suffix}@example.test`,
          `Bearer CP3performance${suffix}abcdefghijkl`,
        )
      }
    })()
    database.close()

    const started = performance.now()
    const captured = await captureMigrationSource(databaseSource(data, "bounded-verifier"), target(tmp.path))
    expect(performance.now() - started).toBeLessThan(6_000)
    expect(await snapshotRecordFiles(captured.snapshotDirectory)).toEqual(["database/main.sqlite"])
  }, 30_000)

  test.each([
    ["count", 10_001, 20],
    ["bytes", 600, 900],
  ])(
    "enforces the incremental credential %s budget",
    async (_kind, rows, payloadBytes) => {
      await using tmp = await tmpdir()
      const data = path.join(tmp.path, "legacy-data")
      await mkdir(data, { recursive: true })
      const database = new Database(path.join(data, "opencode.db"), { create: true })
      database.run("CREATE TABLE account(id TEXT PRIMARY KEY, access_token TEXT)")
      const insert = database.prepare("INSERT INTO account VALUES (?, ?)")
      database.transaction(() => {
        for (let index = 0; index < rows; index++) {
          insert.run(`account_${index}`, `Bearer ${index.toString().padStart(5, "0")}-${"X".repeat(payloadBytes)}`)
        }
      })()
      database.close()

      await expect(
        captureMigrationSource(databaseSource(data, `candidate-${_kind}-budget`), target(tmp.path)),
      ).rejects.toThrow("credential verification budget")
    },
    30_000,
  )

  test("serializes WAL-visible rows with durable main/WAL preservation and no SQLite temp spill", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    const monitoredTemp = path.join(tmp.path, "sqlite-temp")
    await mkdir(data, { recursive: true })
    await mkdir(monitoredTemp, { recursive: true })
    const legacyDatabase = path.join(data, "opencode.db")
    const writer = new Database(legacyDatabase, { create: true })
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, model TEXT)")
    writer.run("INSERT INTO session VALUES ('wal_session', 'WAL-visible retained row', NULL)")
    const sourceMain = await readFile(legacyDatabase)
    const sourceWal = await readFile(`${legacyDatabase}-wal`)
    const sourceShm = await readFile(`${legacyDatabase}-shm`)
    const events: string[] = []
    const watcher = watch(monitoredTemp, (_event, name) => events.push(String(name)))

    const child = Bun.spawn(
      [
        process.execPath,
        "test/fixture/migration-capture-worker.ts",
        JSON.stringify({
          source: databaseSource(data, "wal-worker"),
          destination: target(tmp.path),
        }),
      ],
      { cwd: path.join(import.meta.dir, "../.."), env: { ...process.env, TMPDIR: monitoredTemp }, stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    watcher.close()
    const captured = JSON.parse(await new Response(child.stdout).text()) as {
      snapshotDigest: string
      snapshotDirectory: string
    }
    const second = await captureMigrationSource(
      databaseSource(data, "wal-worker"),
      target(path.join(tmp.path, "second")),
    )
    expect(events).toEqual([])
    expect(await readFile(legacyDatabase)).toEqual(sourceMain)
    expect(await readFile(`${legacyDatabase}-wal`)).toEqual(sourceWal)
    expect(sourceShm.byteLength).toBeGreaterThan(0)
    expect((await readFile(`${legacyDatabase}-shm`)).byteLength).toBeGreaterThan(0)
    expect(second.snapshotDigest).toBe(captured.snapshotDigest)
    expect(await readFile(path.join(second.snapshotDirectory, "records", "database", "main.sqlite"))).toEqual(
      await readFile(path.join(captured.snapshotDirectory, "records", "database", "main.sqlite")),
    )
    expect(databaseHealth(writer, "session")).toEqual({ integrity_check: "ok", rows: 1 })
    writer.close()
    const sealed = new Database(path.join(captured.snapshotDirectory, "records", "database", "main.sqlite"), {
      readonly: true,
    })
    expect(sealed.query("SELECT title FROM session").get()).toEqual({ title: "WAL-visible retained row" })
    sealed.close()
    const reopened = new Database(legacyDatabase, { readonly: true })
    expect(databaseHealth(reopened, "session")).toEqual({ integrity_check: "ok", rows: 1 })
    reopened.close()
  })

  test("rejects a WAL-backed over-cap logical image before serialization with bounded child RSS", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    const monitoredTemp = path.join(tmp.path, "sqlite-temp")
    const serializeMarker = path.join(tmp.path, "serialize-called")
    await mkdir(data, { recursive: true })
    await mkdir(monitoredTemp, { recursive: true })
    const legacyDatabase = path.join(data, "opencode.db")
    const writer = new Database(legacyDatabase, { create: true })
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA wal_autocheckpoint = 0")
    writer.run("CREATE TABLE payload(id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)")
    writer.run("INSERT INTO payload VALUES (1, zeroblob(?))", [33 * 1024 * 1024])
    const sourceMain = await readFile(legacyDatabase)
    const sourceWal = await readFile(`${legacyDatabase}-wal`)

    const child = Bun.spawn(
      [
        process.execPath,
        "test/fixture/migration-capture-worker.ts",
        JSON.stringify({
          source: databaseSource(data, "wal-over-cap"),
          destination: target(tmp.path),
          observeSerialize: serializeMarker,
          reportFailure: true,
        }),
      ],
      { cwd: path.join(import.meta.dir, "../.."), env: { ...process.env, TMPDIR: monitoredTemp }, stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    const report = JSON.parse(await new Response(child.stdout).text()) as {
      error: string
      rssBefore: number
      rssAfter: number
    }
    expect(report.error).toContain("capture budget")
    expect(report.rssAfter - report.rssBefore).toBeLessThan(16 * 1024 * 1024)
    expect(await Bun.file(serializeMarker).exists()).toBe(false)
    expect(await readdir(monitoredTemp)).toEqual([])
    expect(await readFile(legacyDatabase)).toEqual(sourceMain)
    expect(await readFile(`${legacyDatabase}-wal`)).toEqual(sourceWal)
    expect(databaseHealth(writer, "payload")).toEqual({ integrity_check: "ok", rows: 1 })
    writer.close()
    const reopened = new Database(legacyDatabase, { readonly: true })
    expect(databaseHealth(reopened, "payload")).toEqual({ integrity_check: "ok", rows: 1 })
    reopened.close()
  }, 30_000)

  test("rejects an oversized discarded BLOB before candidate copying or base64 identity allocation", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "legacy-data")
    const monitoredTemp = path.join(tmp.path, "sqlite-temp")
    const base64Marker = path.join(tmp.path, "base64-called")
    await mkdir(data, { recursive: true })
    await mkdir(monitoredTemp, { recursive: true })
    const legacyDatabase = path.join(data, "opencode.db")
    const writer = new Database(legacyDatabase, { create: true })
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA wal_autocheckpoint = 0")
    writer.run("CREATE TABLE permission(project_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    writer.run("INSERT INTO permission VALUES ('project_1', zeroblob(?))", [24 * 1024 * 1024])
    const sourceMain = await readFile(legacyDatabase)
    const sourceWal = await readFile(`${legacyDatabase}-wal`)

    const child = Bun.spawn(
      [
        process.execPath,
        "test/fixture/migration-capture-worker.ts",
        JSON.stringify({
          source: databaseSource(data, "candidate-copy-budget"),
          destination: target(tmp.path),
          observeBase64: base64Marker,
          reportFailure: true,
        }),
      ],
      { cwd: path.join(import.meta.dir, "../.."), env: { ...process.env, TMPDIR: monitoredTemp }, stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    const report = JSON.parse(await new Response(child.stdout).text()) as {
      error: string
      rssBefore: number
      rssAfter: number
    }
    expect(report.error).toContain("credential verification budget")
    expect(report.rssAfter - report.rssBefore).toBeLessThan(128 * 1024 * 1024)
    expect(await Bun.file(base64Marker).exists()).toBe(false)
    expect(await readdir(monitoredTemp)).toEqual([])
    expect(await readFile(legacyDatabase)).toEqual(sourceMain)
    expect(await readFile(`${legacyDatabase}-wal`)).toEqual(sourceWal)
    expect(databaseHealth(writer, "permission")).toEqual({ integrity_check: "ok", rows: 1 })
    writer.close()
    const reopened = new Database(legacyDatabase, { readonly: true })
    expect(databaseHealth(reopened, "permission")).toEqual({ integrity_check: "ok", rows: 1 })
    reopened.close()
  }, 30_000)

  test.each(["pre-sanitize", "post-sanitize"])(
    "leaves no credential-bearing filesystem orphan after a %s process exit",
    async (edge) => {
      await using tmp = await tmpdir()
      const data = path.join(tmp.path, "legacy-data")
      const monitoredTemp = path.join(tmp.path, "sqlite-temp")
      await mkdir(data, { recursive: true })
      await mkdir(monitoredTemp, { recursive: true })
      const legacyDatabase = path.join(data, "opencode.db")
      const database = new Database(legacyDatabase, { create: true })
      database.run("CREATE TABLE account(id TEXT PRIMARY KEY, access_token TEXT)")
      database.run("INSERT INTO account VALUES ('account_1', ?)", [sentinel(`crash-${edge}`, 79)])
      database.close()
      const sourceMain = await readFile(legacyDatabase)

      const child = Bun.spawn(
        [
          process.execPath,
          "test/fixture/migration-capture-worker.ts",
          JSON.stringify({
            source: databaseSource(data, `crash-${edge}`),
            destination: target(tmp.path),
            crash: edge,
          }),
        ],
        { cwd: path.join(import.meta.dir, "../.."), env: { ...process.env, TMPDIR: monitoredTemp }, stderr: "pipe" },
      )
      expect(await child.exited).not.toBe(0)
      expect(await readdir(monitoredTemp)).toEqual([])
      expect(await readFile(legacyDatabase)).toEqual(sourceMain)
    },
  )

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

function databaseSource(data: string, id: string): MigrationSource {
  return {
    id,
    label: "Existing BharatCode data · opencode-cli · 00000000",
    kind: "opencode-cli",
    roots: { data },
  }
}

async function snapshotRecordFiles(snapshotDirectory: string) {
  const root = path.join(snapshotDirectory, "records")
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).toSorted()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? path.posix.join(prefix, name) : name
      if ((await lstat(absolute)).isDirectory()) await visit(absolute, relative)
      else files.push(relative)
    }
  }
  await visit(root, "")
  return files
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

function databaseHealth(database: Database, table: "payload" | "permission" | "session") {
  const integrity = database.query("PRAGMA integrity_check").get() as { integrity_check: string }
  const rows = database.query(`SELECT count(*) AS rows FROM ${table}`).get() as { rows: number }
  return { integrity_check: integrity.integrity_check, rows: rows.rows }
}
