import { StorageSQLite } from "#storage-sqlite"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import { windowsCredentialStore } from "@opencode-ai/core/util/windows-credential-store"

import { withMigrationMaintenanceLockSync } from "./migration-maintenance-lock"
import { quarantineWindowsMarker } from "./schema-marker.windows"

export type MarkerState =
  | "healthy"
  | "missing"
  | "invalid"
  | "unreadable"
  | "permission-invalid"
  | "schema-mismatch"
  | "corrupt"
export type MarkerDiagnosis = { state: MarkerState; inferredVersion?: string }
export type SchemaContract = {
  tables: readonly { name: string; sql: string; columns: readonly string[]; foreignKeys: readonly string[] }[]
  indexes: readonly { name: string; table: string; sql: string }[]
}
export type SchemaDatabase = { rows: (sql: string) => readonly Record<string, unknown>[]; close: () => void }
export type ReleasedSchemaCandidate = { version: string; schema: SchemaContract }
export type DiagnoseMarkerInput = {
  databasePath: string
  candidates: readonly ReleasedSchemaCandidate[]
  open: (path: string, options: { readonly: boolean }) => SchemaDatabase
}
export type RepairMarkerInput = DiagnoseMarkerInput & { confirmed: true }

type MarkerInspection = { state: Exclude<MarkerState, "healthy" | "schema-mismatch" | "corrupt">; version?: string }

export function diagnoseSchemaMarker(input: DiagnoseMarkerInput): MarkerDiagnosis {
  const marker = inspectMarker(markerPath(input.databasePath))
  const before = inspectDatabase(input.databasePath)
  if (!before) return { state: "corrupt" }
  const database = (() => {
    try {
      return input.open(input.databasePath, { readonly: true })
    } catch {
      return undefined
    }
  })()
  if (!database) return { state: "corrupt" }
  const schema = (() => {
    try {
      const integrity = database.rows("PRAGMA integrity_check")
      if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") return
      return captureSchemaContract(database)
    } catch {
      return
    } finally {
      database.close()
    }
  })()
  if (!schema || !sameDatabase(before, inspectDatabase(input.databasePath))) return { state: "corrupt" }
  const candidates = input.candidates.filter((candidate) => sameSchema(candidate.schema, schema))
  if (candidates.length !== 1) return { state: "schema-mismatch" }
  const inferredVersion = candidates[0]!.version
  if (marker.version === inferredVersion && marker.state === "invalid") return { state: "healthy", inferredVersion }
  if (marker.version) return { state: "schema-mismatch", inferredVersion }
  return { state: marker.state, inferredVersion }
}

export function repairSchemaMarker(input: RepairMarkerInput): {
  state: "unchanged" | "repaired" | "failed"
  diagnosis: MarkerDiagnosis
  quarantine?: string
} {
  if (input.confirmed !== true) return { state: "failed", diagnosis: { state: "unreadable" } }
  return withMigrationMaintenanceLockSync(path.dirname(input.databasePath), () => {
    const identity = inspectDatabase(input.databasePath)
    if (!identity) return { state: "failed", diagnosis: { state: "corrupt" } }
    const diagnosis = diagnoseSchemaMarker(input)
    if (diagnosis.state === "healthy") return { state: "unchanged", diagnosis }
    if (!diagnosis.inferredVersion || diagnosis.state === "corrupt") return { state: "failed", diagnosis }
    if (process.platform === "win32" && (diagnosis.state === "permission-invalid" || diagnosis.state === "unreadable"))
      return { state: "failed", diagnosis }
    if (!sameDatabase(identity, inspectDatabase(input.databasePath)))
      return { state: "failed", diagnosis: { state: "corrupt" } }
    let quarantine: string | undefined
    let published = false
    try {
      const marker = markerPath(input.databasePath)
      if (existsSync(marker)) {
        quarantine = quarantineMarker(marker)
      }
      if (!sameDatabase(identity, inspectDatabase(input.databasePath))) {
        return { state: "failed", diagnosis: { state: "corrupt" }, ...(quarantine ? { quarantine } : {}) }
      }
      writeMarker(marker, diagnosis.inferredVersion, () => sameDatabase(identity, inspectDatabase(input.databasePath)))
      published = true
      if (!sameDatabase(identity, inspectDatabase(input.databasePath))) {
        quarantine = quarantineMarker(marker)
        return { state: "failed", diagnosis: { state: "corrupt" }, quarantine }
      }
      const verified = diagnoseSchemaMarker(input)
      if (verified.state !== "healthy") {
        quarantine = quarantineMarker(marker)
        return { state: "failed", diagnosis: verified, quarantine }
      }
      return { state: "repaired", diagnosis: verified, ...(quarantine ? { quarantine } : {}) }
    } catch {
      const marker = markerPath(input.databasePath)
      if (published && existsSync(marker)) {
        quarantine = quarantineMarker(marker)
      }
      return { state: "failed", diagnosis, ...(quarantine ? { quarantine } : {}) }
    }
  })
}

export function captureSchemaContract(database: SchemaDatabase): SchemaContract {
  const tables = database
    .rows("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((table) => {
      const name = requireString(table.name)
      return {
        name,
        sql: normalizeSql(requireString(table.sql)),
        columns: database
          .rows(`PRAGMA table_info(${quoteSql(name)})`)
          .map((column) =>
            [column.name, column.type, column.notnull, column.dflt_value ?? "", column.pk].map(String).join("|"),
          ),
        foreignKeys: database
          .rows(`PRAGMA foreign_key_list(${quoteSql(name)})`)
          .map((foreign) =>
            [
              foreign.id,
              foreign.seq,
              foreign.table,
              foreign.from,
              foreign.to,
              foreign.on_update,
              foreign.on_delete,
              foreign.match,
            ]
              .map(String)
              .join("|"),
          )
          .toSorted(),
      }
    })
  const indexes = database
    .rows("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .map((index) => ({
      name: requireString(index.name),
      table: requireString(index.tbl_name),
      sql: normalizeSql(requireString(index.sql)),
    }))
  return { tables, indexes }
}

export function releasedSchemaCandidatesFromMigrations(
  migrations: readonly { version: string; sql: string }[],
  bootstrapSql?: string,
): readonly ReleasedSchemaCandidate[] {
  const database = new StorageSQLite(":memory:")
  try {
    database.run("PRAGMA foreign_keys = ON")
    if (bootstrapSql) database.run(bootstrapSql)
    return migrations.map((migration) => {
      database.run(migration.sql)
      return {
        version: migration.version,
        schema: captureSchemaContract({
          rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
          close: () => {},
        }),
      }
    })
  } finally {
    database.close()
  }
}

function inspectMarker(marker: string): MarkerInspection {
  const info = (() => {
    try {
      return lstatSync(marker)
    } catch (error) {
      if (nodeError(error, "ENOENT")) return undefined
      return null
    }
  })()
  if (info === undefined) return { state: "missing" }
  if (info === null) return { state: "unreadable" }
  if (!info.isFile()) return { state: info.isSymbolicLink() ? "permission-invalid" : "invalid" }
  if (
    info.nlink !== 1 ||
    (process.platform !== "win32" &&
      ((info.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && info.uid !== process.getuid())))
  ) {
    return { state: "permission-invalid" }
  }
  try {
    // Windows mode bits are synthetic, not ACL evidence. This reads and validates
    // the same held single-link/no-reparse object and its retained private parent.
    const value = process.platform === "win32" ? windowsCredentialStore(marker).read() : readFileSync(marker, "utf8")
    if (value === undefined) return { state: "missing" }
    if (!/^[A-Za-z0-9._-]{1,128}\n$/.test(value)) return { state: "invalid" }
    return { state: "invalid", version: value.trim() }
  } catch {
    return { state: process.platform === "win32" ? "permission-invalid" : "unreadable" }
  }
}

function inspectDatabase(database: string) {
  try {
    const info = lstatSync(database)
    if (!info.isFile() || info.isSymbolicLink()) return
    return { dev: info.dev, ino: info.ino, size: info.size }
  } catch {
    return
  }
}

function sameDatabase(
  left: { dev: number; ino: number; size: number } | undefined,
  right: { dev: number; ino: number; size: number } | undefined,
) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function quarantineMarker(marker: string) {
  const info = lstatSync(marker)
  const digest = createHash("sha256")
    .update(`${info.dev}\0${info.ino}\0${info.mode}\0${info.size}`)
    .digest("hex")
    .slice(0, 16)
  const base = `${marker}.quarantine-${digest}`
  const quarantine = existsSync(base) ? `${base}-${randomUUID()}` : base
  if (process.platform === "win32") quarantineWindowsMarker(marker, quarantine)
  else {
    renameSync(marker, quarantine)
    syncDirectory(path.dirname(marker))
  }
  return quarantine
}

function writeMarker(marker: string, version: string, validate: () => boolean) {
  if (process.platform === "win32") {
    if (!validate()) throw new Error("database changed")
    // Private held-parent publication: write-through file, flush before/after
    // native rename. Errors (including uncertain activation) propagate, never
    // become successful repair or a directory-fsync suppression.
    windowsCredentialStore(marker).publish(`${version}\n`)
    return
  }
  const temporary = `${marker}.tmp-${randomUUID()}`
  try {
    const descriptor = openSync(temporary, "wx", 0o600)
    try {
      writeSync(descriptor, `${version}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(temporary, 0o600)
    if (!validate()) throw new Error("database changed")
    renameSync(temporary, marker)
    syncDirectory(path.dirname(marker))
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
}

function syncDirectory(directory: string) {
  const descriptor = openSync(directory, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function markerPath(database: string) {
  return path.join(path.dirname(database), ".schema-version")
}

function sameSchema(left: SchemaContract, right: SchemaContract) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeSql(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function quoteSql(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function requireString(value: unknown) {
  if (typeof value !== "string") throw new Error("invalid SQLite schema")
  return value
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

export * as SchemaMarker from "./schema-marker"
