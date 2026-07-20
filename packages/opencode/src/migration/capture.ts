import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"

import { sanitizeMigrationRecord } from "./sanitize"
import type { MigrationSource } from "./source"

export type CapturedSource = {
  sourceID: string
  contentFingerprint: string
  snapshotDigest: string
  snapshotDirectory: string
  records: number
}

export type MigrationDestination = {
  data: string
  config: string
  state: string
  database: string
  storage: string
}

type CapturedEntry = { relative: string; bytes: Uint8Array; digest: string; size: number }
type Manifest = {
  version: 1
  contentFingerprint: string
  entries: readonly { relative: string; digest: string; size: number }[]
}

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_FILES = 50_000
const MAX_SQLITE_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_SENSITIVE_VALUES = 10_000
const MAX_SENSITIVE_VALUE_BYTES = 512 * 1024
const DROPPED_SQLITE_TABLES = new Set(["session_share", "account_state", "account", "control_account"])
const CREDENTIAL_VALUE =
  /(?:bearer\s+[a-z0-9._-]{12,}|(?:access|refresh|id)[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|password|private[-_ ]?key|\beyJ[a-z0-9_-]{12,})/i
const CREDENTIAL_COLUMN = /(?:^|_)(?:token|secret|password|authorization|private_key)(?:$|_)/i
const SQLITE_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries({
    __drizzle_migrations: ["id", "hash", "created_at"],
    account: [
      "id",
      "email",
      "url",
      "access_token",
      "refresh_token",
      "token_expiry",
      "selected_org_id",
      "time_created",
      "time_updated",
    ],
    account_state: ["id", "active_account_id", "active_org_id"],
    control_account: [
      "email",
      "url",
      "access_token",
      "refresh_token",
      "token_expiry",
      "active",
      "time_created",
      "time_updated",
    ],
    data_migration: ["name", "time_completed"],
    event: ["id", "aggregate_id", "seq", "type", "data"],
    event_sequence: ["aggregate_id", "seq", "owner_id"],
    message: ["id", "session_id", "time_created", "time_updated", "data"],
    part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
    permission: ["project_id", "time_created", "time_updated", "data"],
    project: [
      "id",
      "worktree",
      "vcs",
      "name",
      "icon_url",
      "icon_url_override",
      "icon_color",
      "time_created",
      "time_updated",
      "time_initialized",
      "sandboxes",
      "commands",
    ],
    session: [
      "id",
      "project_id",
      "workspace_id",
      "parent_id",
      "slug",
      "directory",
      "path",
      "title",
      "version",
      "share_url",
      "summary_additions",
      "summary_deletions",
      "summary_files",
      "summary_diffs",
      "cost",
      "tokens_input",
      "tokens_output",
      "tokens_reasoning",
      "tokens_cache_read",
      "tokens_cache_write",
      "revert",
      "permission",
      "goal",
      "agent",
      "model",
      "time_created",
      "time_updated",
      "time_compacting",
      "time_archived",
    ],
    session_entry: ["id", "session_id", "type", "time_created", "time_updated", "data"],
    session_message: ["id", "session_id", "type", "time_created", "time_updated", "data"],
    session_share: ["session_id", "id", "secret", "url", "time_created", "time_updated"],
    todo: ["session_id", "content", "status", "priority", "position", "time_created", "time_updated"],
    workspace: ["id", "type", "name", "branch", "directory", "extra", "project_id", "time_used", "config"],
  }).map(([table, columns]) => [table, new Set(columns)]),
)

export class MigrationCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeMigrationCaptureError"
  }
}

export async function captureMigrationSource(
  source: MigrationSource,
  destination: MigrationDestination,
): Promise<CapturedSource> {
  const entries = await scanSource(source)
  const contentFingerprint = fingerprint(entries)
  const manifest = manifestBytes(contentFingerprint, entries)
  const snapshotDigest = digest(manifest)
  const parent = path.join(destination.state, "migration-snapshots")
  const snapshotDirectory = path.join(parent, snapshotDigest)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const staging = path.join(parent, `.capture-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    await mkdir(path.join(staging, "records"), { mode: 0o700 })
    for (const entry of entries) await writeDurable(path.join(staging, "records", entry.relative), entry.bytes)
    await writeDurable(path.join(staging, "manifest.json"), manifest)
    await syncDirectory(staging)
    const current = await scanSource(source)
    if (fingerprint(current) !== contentFingerprint) {
      throw new MigrationCaptureError("The migration source changed while BharatCode was sealing it.")
    }
    await rename(staging, snapshotDirectory).catch(async (error) => {
      if (!nodeError(error, "EEXIST") && !nodeError(error, "ENOTEMPTY")) throw error
      if (!(await snapshotMatches(snapshotDirectory, snapshotDigest))) {
        throw new MigrationCaptureError("A migration snapshot collision failed verification.")
      }
      await rm(staging, { recursive: true })
    })
    await syncDirectory(parent)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (error instanceof MigrationCaptureError) throw error
    throw new MigrationCaptureError("BharatCode could not durably seal the migration source.")
  }
  return { sourceID: source.id, contentFingerprint, snapshotDigest, snapshotDirectory, records: entries.length }
}

export async function fingerprintMigrationSource(source: MigrationSource) {
  return fingerprint(await scanSource(source))
}

export async function verifyCapturedSnapshot(input: {
  snapshotDirectory: string
  snapshotDigest: string
  contentFingerprint: string
}) {
  if (!(await snapshotMatches(input.snapshotDirectory, input.snapshotDigest))) return false
  const manifest = JSON.parse(await readFile(path.join(input.snapshotDirectory, "manifest.json"), "utf8")) as Manifest
  return manifest.contentFingerprint === input.contentFingerprint
}

export async function verifyCapturedSource(input: {
  captured: CapturedSource
  source: MigrationSource
}): Promise<boolean> {
  try {
    if (input.captured.sourceID !== input.source.id) return false
    if (fingerprint(await scanSource(input.source)) !== input.captured.contentFingerprint) return false
    return snapshotMatches(input.captured.snapshotDirectory, input.captured.snapshotDigest)
  } catch {
    return false
  }
}

async function scanSource(source: MigrationSource) {
  const entries = (
    await Promise.all(
      Object.entries(source.roots).map(async ([role, root]) =>
        root ? scanDirectory(role, root) : Promise.resolve([]),
      ),
    )
  )
    .flat()
    .toSorted((left, right) => left.relative.localeCompare(right.relative))
  if (new Set(entries.map((entry) => entry.relative)).size !== entries.length) {
    throw new MigrationCaptureError("The migration source contained a canonical destination collision.")
  }
  if (entries.length > MAX_FILES || entries.reduce((total, entry) => total + entry.size, 0) > MAX_TOTAL_BYTES) {
    throw new MigrationCaptureError("The migration source exceeded its capture budget.")
  }
  return entries
}

async function scanDirectory(role: string, root: string): Promise<CapturedEntry[]> {
  const result: CapturedEntry[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const names = (await readdir(directory)).toSorted()
    const databases = new Set<string>()
    for (const name of names) {
      if (/\.db$/i.test(name) && (await lstat(path.join(directory, name))).isFile()) databases.add(name)
    }
    for (const name of names) {
      const sidecar = sqliteSidecar(name, databases)
      if (
        sidecar === "unexplained" ||
        (sidecar === "associated" && !(await lstat(path.join(directory, name))).isFile())
      ) {
        throw new MigrationCaptureError("A migration source contained an unexplained database-adjacent sidecar.")
      }
    }
    for (const name of names) {
      const absolute = path.join(directory, name)
      const relative = prefix ? path.posix.join(prefix, name) : name
      const before = await lstat(absolute)
      if (before.isSymbolicLink()) throw new MigrationCaptureError("A migration source contained an unsupported link.")
      if (before.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (!before.isFile()) throw new MigrationCaptureError("A migration source contained an unsupported entry.")
      if (before.size > MAX_FILE_BYTES)
        throw new MigrationCaptureError("A migration source file exceeded its capture budget.")
      if (sqliteSidecar(name, databases) === "associated") continue
      const bytes = /\.db$/i.test(relative) ? snapshotDatabase(absolute) : await readFile(absolute)
      const after = await lstat(absolute)
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new MigrationCaptureError("The migration source changed during capture.")
      }
      const sanitized = sanitizeBytes(role, relative, bytes)
      const capturedRelative = /\.db$/i.test(relative)
        ? "database/main.sqlite"
        : path.posix.join(role, canonicalRelative(role, relative))
      if (result.some((entry) => entry.relative === capturedRelative)) {
        throw new MigrationCaptureError("The migration source contained a canonical destination collision.")
      }
      result.push({
        relative: capturedRelative,
        bytes: sanitized,
        digest: digest(sanitized),
        size: sanitized.byteLength,
      })
    }
  }
  await visit(root, "")
  return result
}

function sqliteSidecar(name: string, databases: ReadonlySet<string>): "associated" | "unexplained" | undefined {
  const known = /^(.*\.db)-(?:journal|wal|shm)$/i.exec(name) ?? /^(.*\.db)-mj[0-9a-f]{8}$/i.exec(name)
  if (known) return databases.has(known[1]) ? "associated" : "unexplained"
  const adjacent = /^(.*\.db)-/i.exec(name)
  if (adjacent && databases.has(adjacent[1])) return "unexplained"
  return undefined
}

function canonicalRelative(role: string, relative: string) {
  if (role !== "config" || relative.includes("/")) return relative
  if (relative === "opencode.json") return "bharatcode.json"
  if (relative === "opencode.jsonc") return "bharatcode.jsonc"
  return relative
}

function sanitizeBytes(role: string, relative: string, bytes: Uint8Array) {
  if (!/\.(?:json|jsonc|dat)$/i.test(relative)) return bytes
  const text = new TextDecoder().decode(bytes)
  const errors: ParseError[] = []
  const value = /\.jsonc$/i.test(relative)
    ? parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
    : (JSON.parse(text) as unknown)
  if (errors.length > 0) throw new MigrationCaptureError("A migration JSONC record was invalid.")
  const kind =
    role === "config"
      ? path.basename(relative).startsWith("tui.")
        ? "tui"
        : "config"
      : role === "desktop"
        ? "desktop"
        : relative.includes("project")
          ? "project"
          : "session"
  return new TextEncoder().encode(JSON.stringify(sanitizeMigrationRecord({ kind, value }).value))
}

function snapshotDatabase(file: string) {
  const source = new Database(file, { readonly: true })
  let logical: Uint8Array
  try {
    logical = standaloneSQLiteImage(source.serialize())
  } finally {
    source.close()
  }
  if (logical.byteLength > MAX_SQLITE_IMAGE_BYTES) {
    throw new MigrationCaptureError("The migration database exceeded its capture budget.")
  }
  const database = Database.deserialize(logical)
  let sensitiveValues: readonly Uint8Array[] = []
  let sanitized: Uint8Array
  try {
    database.run("PRAGMA foreign_keys = OFF")
    database.run("PRAGMA journal_mode = MEMORY")
    database.run("PRAGMA temp_store = MEMORY")
    database.run("PRAGMA secure_delete = ON")
    const tempStore = database.query("PRAGMA temp_store").get() as { temp_store?: number } | null
    const secureDelete = database.query("PRAGMA secure_delete").get() as { secure_delete?: number } | null
    const journal = database.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null
    if (tempStore?.temp_store !== 2 || secureDelete?.secure_delete !== 1 || journal?.journal_mode !== "memory") {
      throw new MigrationCaptureError("The migration database could not enable in-memory secure sanitation.")
    }
    assertKnownSQLiteSchema(database)
    sensitiveValues = collectSensitiveRemovedSQLiteValues(database)
    database.transaction(() => {
      for (const table of DROPPED_SQLITE_TABLES) {
        if (hasTable(database, table)) database.run(`DROP TABLE ${quoteIdentifier(table)}`)
      }
      deleteRows(database, ["permission", "event", "event_sequence", "data_migration"])
      clearColumns(database, "project", ["commands", "icon_url", "icon_url_override"])
      setColumn(database, "project", "sandboxes", "[]")
      clearColumns(database, "session", ["share_url", "model", "permission", "agent"])
      clearColumns(database, "workspace", ["extra"])
      setColumn(database, "workspace", "config", "{}")
      sanitizeJsonColumn(database, "message")
      sanitizeJsonColumn(database, "part")
      sanitizeJsonColumn(database, "session_entry")
      sanitizeJsonColumn(database, "session_message")
      assertSanitizedSQLite(database)
    })()
    database.run("VACUUM")
    assertSanitizedSQLite(database)
    sanitized = database.serialize()
  } finally {
    database.close()
  }
  return verifySerializedSQLiteSnapshot({ bytes: sanitized, sensitiveValues })
}

function standaloneSQLiteImage(serialized: Uint8Array) {
  const image = Buffer.from(serialized)
  if (
    image.byteLength < 100 ||
    image.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
    ![1, 2].includes(image[18] ?? 0) ||
    ![1, 2].includes(image[19] ?? 0)
  ) {
    throw new MigrationCaptureError("The migration database serialization was invalid.")
  }
  image[18] = 1
  image[19] = 1
  return image
}

function collectSensitiveRemovedSQLiteValues(database: Database) {
  const removed = new Map<string, Uint8Array>()
  for (const table of [...DROPPED_SQLITE_TABLES, "permission", "event", "event_sequence", "data_migration"]) {
    collectSQLiteValues(database, table, undefined, removed)
  }
  for (const [table, columns] of [
    ["project", ["commands", "icon_url", "icon_url_override", "sandboxes"]],
    ["session", ["share_url", "model", "permission", "agent"]],
    ["workspace", ["extra", "config"]],
    ["message", ["data"]],
    ["part", ["data"]],
    ["session_entry", ["data"]],
    ["session_message", ["data"]],
    ["permission", ["data"]],
    ["event", ["data"]],
  ] as const) {
    collectSQLiteValues(database, table, columns, removed)
  }
  const sensitive = new Map<string, Uint8Array>()
  for (const value of removed.values()) {
    if (credentialShaped(value)) collectBytes(value, sensitive)
  }
  for (const table of DROPPED_SQLITE_TABLES) {
    if (!hasTable(database, table)) continue
    const columns = (database.query(`PRAGMA table_info(${quoteSql(table)})`).all() as { name: string }[])
      .map((column) => column.name)
      .filter((column) => CREDENTIAL_COLUMN.test(column) || (table === "session_share" && column === "url"))
    const explicit = new Map<string, Uint8Array>()
    collectSQLiteValues(database, table, columns, explicit)
    for (const value of explicit.values()) {
      if (value.byteLength < 8) {
        throw new MigrationCaptureError("The migration database contained a short credential value.")
      }
      collectBytes(value, sensitive)
    }
  }
  const values = [...sensitive.values()]
  const bytes = values.reduce((total, value) => total + value.byteLength, 0)
  if (values.length > MAX_SENSITIVE_VALUES || bytes > MAX_SENSITIVE_VALUE_BYTES) {
    throw new MigrationCaptureError("The migration database exceeded its credential verification budget.")
  }
  return values.toSorted((left, right) => Buffer.compare(left, right))
}

function collectSQLiteValues(
  database: Database,
  table: string,
  columns: readonly string[] | undefined,
  values: Map<string, Uint8Array>,
) {
  if (!hasTable(database, table)) return
  const selected = columns?.filter((column) => hasColumn(database, table, column))
  if (selected?.length === 0) return
  const projection = selected?.map(quoteIdentifier).join(", ") ?? "*"
  for (const row of database.query(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).all() as Record<
    string,
    unknown
  >[]) {
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        collectBytes(new TextEncoder().encode(value), values)
        if (selected?.includes("data")) collectJsonStrings(value, values)
        continue
      }
      if (value instanceof Uint8Array) collectBytes(value, values)
    }
  }
}

function collectJsonStrings(value: string, values: Map<string, Uint8Array>) {
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      collectBytes(new TextEncoder().encode(item), values)
      return
    }
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (item && typeof item === "object") Object.values(item).forEach(visit)
  }
  try {
    visit(JSON.parse(value) as unknown)
  } catch {
    // Deleted capability tables may contain legacy plain text; the raw bytes are already collected.
  }
}

function collectBytes(value: Uint8Array, values: Map<string, Uint8Array>) {
  if (value.byteLength === 0) return
  values.set(Buffer.from(value).toString("base64"), value)
}

function credentialShaped(value: Uint8Array) {
  try {
    return CREDENTIAL_VALUE.test(new TextDecoder("utf-8", { fatal: true }).decode(value))
  } catch {
    return false
  }
}

function verifySerializedSQLiteSnapshot(input: { bytes: Uint8Array; sensitiveValues: readonly Uint8Array[] }) {
  if (input.bytes.byteLength > MAX_SQLITE_IMAGE_BYTES) {
    throw new MigrationCaptureError("The sanitized migration database exceeded its capture budget.")
  }
  const database = Database.deserialize(input.bytes, true)
  const physical = (() => {
    try {
      const integrity = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
      if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
        throw new MigrationCaptureError("The sanitized migration database failed integrity verification.")
      }
      assertSanitizedSQLite(database)
      const freelist = database.query("PRAGMA freelist_count").get() as { freelist_count?: number } | null
      const pageCount = database.query("PRAGMA page_count").get() as { page_count?: number } | null
      const pageSize = database.query("PRAGMA page_size").get() as { page_size?: number } | null
      if (freelist?.freelist_count !== 0 || !pageCount?.page_count || !pageSize?.page_size) {
        throw new MigrationCaptureError("The sanitized migration database was not physically compact.")
      }
      return { bytes: pageCount.page_count * pageSize.page_size }
    } finally {
      database.close()
    }
  })()
  if (input.bytes.byteLength !== physical.bytes || containsAnyBytes(input.bytes, input.sensitiveValues)) {
    throw new MigrationCaptureError("The sanitized migration database retained removed credential bytes.")
  }
  return input.bytes
}

function containsAnyBytes(haystack: Uint8Array, patterns: readonly Uint8Array[]) {
  if (patterns.length === 0) return false
  const patternBytes = patterns.reduce((total, pattern) => total + pattern.byteLength, 0)
  if (
    haystack.byteLength > MAX_SQLITE_IMAGE_BYTES ||
    patterns.length > MAX_SENSITIVE_VALUES ||
    patternBytes > MAX_SENSITIVE_VALUE_BYTES
  ) {
    throw new MigrationCaptureError("The migration database exceeded its credential verification budget.")
  }
  const nodes = patternBytes + 1
  const firstEdge = new Int32Array(nodes).fill(-1)
  const failure = new Int32Array(nodes)
  const terminal = new Uint8Array(nodes)
  const edgeByte = new Uint8Array(patternBytes)
  const edgeTarget = new Int32Array(patternBytes)
  const edgeNext = new Int32Array(patternBytes).fill(-1)
  let nodeCount = 1
  let edgeCount = 0
  const findEdge = (state: number, byte: number) => {
    for (let edge = firstEdge[state]!; edge !== -1; edge = edgeNext[edge]!) {
      if (edgeByte[edge] === byte) return edgeTarget[edge]!
    }
    return -1
  }
  for (const pattern of patterns) {
    let state = 0
    for (const byte of pattern) {
      const next = findEdge(state, byte)
      if (next !== -1) {
        state = next
        continue
      }
      const parent = state
      state = nodeCount++
      edgeByte[edgeCount] = byte
      edgeTarget[edgeCount] = state
      edgeNext[edgeCount] = firstEdge[parent]!
      firstEdge[parent] = edgeCount++
    }
    terminal[state] = 1
  }
  const queue = new Int32Array(nodeCount)
  let queued = 0
  for (let edge = firstEdge[0]!; edge !== -1; edge = edgeNext[edge]!) queue[queued++] = edgeTarget[edge]!
  for (let index = 0; index < queued; index++) {
    const state = queue[index]!
    for (let edge = firstEdge[state]!; edge !== -1; edge = edgeNext[edge]!) {
      const byte = edgeByte[edge]!
      const child = edgeTarget[edge]!
      let fallback = failure[state]!
      let target = findEdge(fallback, byte)
      while (fallback !== 0 && target === -1) {
        fallback = failure[fallback]!
        target = findEdge(fallback, byte)
      }
      failure[child] = target === -1 ? 0 : target
      terminal[child] ||= terminal[failure[child]!]!
      queue[queued++] = child
    }
  }
  let state = 0
  for (const byte of haystack) {
    let next = findEdge(state, byte)
    while (state !== 0 && next === -1) {
      state = failure[state]!
      next = findEdge(state, byte)
    }
    state = next === -1 ? 0 : next
    if (terminal[state]) return true
  }
  return false
}

function assertKnownSQLiteSchema(database: Database) {
  const objects = database
    .query(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'trigger', 'view') ORDER BY name",
    )
    .all() as { type: string; name: string }[]
  for (const object of objects) {
    const allowed = SQLITE_COLUMNS[object.name]
    if (object.type !== "table" || !allowed) {
      throw new MigrationCaptureError("The migration database contained an unsupported SQLite capability location.")
    }
    if (DROPPED_SQLITE_TABLES.has(object.name)) continue
    const columns = database.query(`PRAGMA table_info(${quoteSql(object.name)})`).all() as { name: string }[]
    if (columns.some((column) => !allowed.has(column.name))) {
      throw new MigrationCaptureError("The migration database contained an unsupported SQLite capability location.")
    }
  }
}

function deleteRows(database: Database, tables: readonly string[]) {
  for (const table of tables) if (hasTable(database, table)) database.run(`DELETE FROM ${quoteIdentifier(table)}`)
}

function clearColumns(database: Database, table: string, columns: readonly string[]) {
  if (!hasTable(database, table)) return
  const present = new Set(
    (database.query(`PRAGMA table_info(${quoteSql(table)})`).all() as { name: string }[]).map((column) => column.name),
  )
  const selected = columns.filter((column) => present.has(column))
  if (selected.length > 0) {
    database.run(
      `UPDATE ${quoteIdentifier(table)} SET ${selected.map((column) => `${quoteIdentifier(column)} = NULL`).join(", ")}`,
    )
  }
}

function setColumn(database: Database, table: string, column: string, value: string) {
  if (!hasColumn(database, table, column)) return
  database.run(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ?`, [value])
}

function sanitizeJsonColumn(database: Database, table: string) {
  if (!hasColumn(database, table, "data")) return
  const update = database.prepare(`UPDATE ${quoteIdentifier(table)} SET data = ? WHERE rowid = ?`)
  for (const row of database.query(`SELECT rowid, data FROM ${quoteIdentifier(table)}`).all() as {
    rowid: number
    data: string
  }[]) {
    const value = sanitizeMigrationRecord({ kind: "session", value: JSON.parse(row.data) as unknown }).value
    update.run(JSON.stringify(value), row.rowid)
  }
}

function assertSanitizedSQLite(database: Database) {
  assertKnownSQLiteSchema(database)
  for (const table of ["permission", "event", "event_sequence", "data_migration"]) {
    if (hasTable(database, table) && database.query(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`).get()) {
      throw new MigrationCaptureError("The migration database retained an active SQLite capability.")
    }
  }
  for (const [table, columns] of [
    ["project", ["commands", "icon_url", "icon_url_override"]],
    ["session", ["share_url", "model", "permission", "agent"]],
    ["workspace", ["extra"]],
  ] as const) {
    for (const column of columns) {
      if (
        hasColumn(database, table, column) &&
        database
          .query(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL LIMIT 1`)
          .get()
      ) {
        throw new MigrationCaptureError("The migration database retained an active SQLite capability.")
      }
    }
  }
  for (const table of ["message", "part", "session_entry", "session_message"]) {
    if (!hasColumn(database, table, "data")) continue
    for (const row of database.query(`SELECT data FROM ${quoteIdentifier(table)}`).all() as { data: string }[]) {
      const parsed = JSON.parse(row.data) as unknown
      if (
        JSON.stringify(sanitizeMigrationRecord({ kind: "session", value: parsed }).value) !== JSON.stringify(parsed)
      ) {
        throw new MigrationCaptureError("The migration database retained an active SQLite capability.")
      }
    }
  }
}

function hasTable(database: Database, table: string) {
  return !!database.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
}

function hasColumn(database: Database, table: string, column: string) {
  if (!hasTable(database, table)) return false
  return (database.query(`PRAGMA table_info(${quoteSql(table)})`).all() as { name: string }[]).some(
    (item) => item.name === column,
  )
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteSql(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function fingerprint(entries: readonly CapturedEntry[]) {
  return createHash("sha256")
    .update(entries.map((entry) => `${entry.relative}\0${entry.size}\0${entry.digest}`).join("\0"))
    .digest("hex")
}

function manifestBytes(contentFingerprint: string, entries: readonly CapturedEntry[]) {
  const manifest: Manifest = {
    version: 1,
    contentFingerprint,
    entries: entries.map((entry) => ({ relative: entry.relative, digest: entry.digest, size: entry.size })),
  }
  return new TextEncoder().encode(JSON.stringify(manifest))
}

async function snapshotMatches(directory: string, expectedDigest: string) {
  const rootEntries = (await readdir(directory)).toSorted()
  if (rootEntries.length !== 2 || rootEntries[0] !== "manifest.json" || rootEntries[1] !== "records") return false
  const bytes = await readFile(path.join(directory, "manifest.json"))
  if (digest(bytes) !== expectedDigest) return false
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) return false
  const expected = new Set<string>()
  for (const entry of manifest.entries) {
    if (!safeRelative(entry.relative)) return false
    if (expected.has(entry.relative)) return false
    expected.add(entry.relative)
    const record = await readFile(path.join(directory, "records", entry.relative))
    if (record.byteLength !== entry.size || digest(record) !== entry.digest) return false
  }
  const actual = await snapshotFiles(path.join(directory, "records"))
  return actual.length === expected.size && actual.every((entry) => expected.has(entry))
}

async function snapshotFiles(root: string) {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).toSorted()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? path.posix.join(prefix, name) : name
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new MigrationCaptureError("A migration snapshot contained an unsupported link.")
      if (info.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (!info.isFile()) throw new MigrationCaptureError("A migration snapshot contained an unsupported entry.")
      files.push(relative)
    }
  }
  await visit(root, "")
  return files
}

async function writeDurable(file: string, bytes: Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(file, 0o600)
  await syncDirectory(path.dirname(file))
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function safeRelative(value: string) {
  return (
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  )
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

export * as MigrationCapture from "./capture"
