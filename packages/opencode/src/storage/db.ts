import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocalContext } from "@/util/local-context"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "@opencode-ai/core/flag/flag"
import { EffectBridge } from "@/effect/bridge"
import { init } from "#db"
import { StorageSQLite } from "#storage-sqlite"
import { Effect, Schema } from "effect"
import {
  diagnoseSchemaMarker,
  releasedSchemaCandidatesFromMigrations,
  repairSchemaMarker,
  type SchemaDatabase,
} from "./schema-marker"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create("NotFoundError", {
  message: Schema.String,
})

const log = Log.create({ service: "db" })

type DatabaseFlags = Pick<RuntimeFlags.Info, "disableChannelDb" | "skipMigrations">

const readRuntimeFlags = () =>
  Effect.runSync(RuntimeFlags.Service.useSync((flags) => flags).pipe(Effect.provide(RuntimeFlags.defaultLayer)))

export function getChannelPath(_flags: Pick<DatabaseFlags, "disableChannelDb"> = readRuntimeFlags()) {
  return Global.Path.database
}

export const getPath = (flags?: Pick<DatabaseFlags, "disableChannelDb">) => {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return path.join(Global.Path.data, Flag.OPENCODE_DB)
  }
  return getChannelPath(flags)
}

export type Transaction = SQLiteTransaction<"sync", void>

type Client = ReturnType<typeof init>

type Journal = { sql: string; timestamp: number; name: string }[]
const DRIZZLE_MIGRATION_SCHEMA = `
  CREATE TABLE "__drizzle_migrations" (
    id INTEGER PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric,
    name text,
    applied_at TEXT
  )
`

export class DatabaseRecoveryRequiredError extends Error {
  constructor() {
    super("BharatCode database recovery is required. Run `bharatcode doctor` before startup.")
    this.name = "BharatCodeDatabaseRecoveryRequiredError"
  }
}

// Drizzle's migrate overloads trigger expensive variance checks here; narrow to the journal overload we actually use.
const migrateFromJournal = migrate as unknown as (db: SQLiteBunDatabase, entries: Journal) => void

function applyMigrations(db: SQLiteBunDatabase, entries: Journal) {
  migrateFromJournal(db, entries)
}

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

function migrationJournal(): Journal {
  return typeof OPENCODE_MIGRATIONS !== "undefined"
    ? OPENCODE_MIGRATIONS
    : migrations(path.join(import.meta.dirname, "../../migration"))
}

export function releasedSchemaCandidates() {
  return releasedSchemaCandidatesFromMigrations(
    migrationJournal().map((entry) => ({ version: entry.name, sql: entry.sql })),
    DRIZZLE_MIGRATION_SCHEMA,
  )
}

let client: Client | undefined
let loaded = false

export const Client = Object.assign(
  (flags: DatabaseFlags = readRuntimeFlags()): Client => {
    if (loaded) return client as Client

    const dbPath = getPath(flags)
    log.info("opening database", { path: dbPath })

    const entries = migrationJournal()
    const markerGate = !Flag.OPENCODE_DB && dbPath !== ":memory:"
    const markerInput = {
      databasePath: dbPath,
      candidates: releasedSchemaCandidatesFromMigrations(
        entries.map((entry) => ({ version: entry.name, sql: entry.sql })),
        DRIZZLE_MIGRATION_SCHEMA,
      ),
      open: openSchemaDatabase,
    }
    if (markerGate && existsSync(dbPath) && diagnoseSchemaMarker(markerInput).state !== "healthy") {
      throw new DatabaseRecoveryRequiredError()
    }

    const db = init(dbPath)

    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")

    // Apply schema migrations
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (flags.skipMigrations) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      applyMigrations(db, entries)
    }

    if (markerGate) {
      const marker = repairSchemaMarker({ ...markerInput, confirmed: true })
      if (marker.state === "failed") {
        db.$client.close()
        throw new DatabaseRecoveryRequiredError()
      }
    }

    client = db
    loaded = true
    return db
  },
  {
    reset: () => {
      loaded = false
      client = undefined
    },
    loaded: () => loaded,
  },
)

export function close() {
  if (!Client.loaded()) return
  Client().$client.close()
  Client.reset()
}

export function openSchemaDatabase(file: string, options: { readonly: boolean }): SchemaDatabase {
  if (!options.readonly) throw new DatabaseRecoveryRequiredError()
  // A read-write connection can checkpoint WAL on close and change the very
  // file identity/size being diagnosed. Inspection must not mutate or create it.
  const database = new StorageSQLite(file, { readonly: true })
  return {
    rows: (sql) => database.query(sql).all() as Record<string, unknown>[],
    close: () => database.close(),
  }
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = EffectBridge.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = EffectBridge.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}

export * as Database from "./db"
