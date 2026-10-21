import { stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { DatabaseSync } from "node:sqlite"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { createSupportBundle, type SupportMetadata } from "./support-bundle"
import type { Channel } from "./branding"

type Input = { channel: Channel; platform: NodeJS.Platform; home: string; temp: string; env: NodeJS.ProcessEnv }

// Pure resolver: importing Global or Database would initialize/migrate storage.
export function resolveSupportPaths(input: Input) {
  const paths = StoragePaths.resolve({
    ...input,
    channel: input.env.BHARATCODE_CHANNEL ?? input.channel,
    home: input.env.OPENCODE_TEST_HOME ?? input.home,
  })
  const api = input.platform === "win32" ? path.win32 : path.posix
  return {
    ...paths,
    config: input.env.BHARATCODE_CONFIG_DIR ?? input.env.OPENCODE_CONFIG_DIR ?? paths.config,
    override: input.env.OPENCODE_CONFIG,
    database:
      input.env.OPENCODE_DB === ":memory:"
        ? ":memory:"
        : input.env.OPENCODE_DB
          ? api.isAbsolute(input.env.OPENCODE_DB)
            ? input.env.OPENCODE_DB
            : api.join(paths.data, input.env.OPENCODE_DB)
          : paths.database,
  }
}

export async function collectSupportMetadata(input: Input): Promise<SupportMetadata> {
  const paths = resolveSupportPaths(input)
  const api = input.platform === "win32" ? path.win32 : path.posix
  const config = Object.fromEntries(
    await Promise.all(
      [
        ["directory", paths.config],
        ["globalJson", api.join(paths.config, "opencode.json")],
        ["globalJsonc", api.join(paths.config, "opencode.jsonc")],
        ["globalLegacy", api.join(paths.config, "config.json")],
        ["override", paths.override],
        ["authStore", paths.auth],
      ].map(async ([name, filename]) => [name, filename ? await present(filename) : false]),
    ),
  )
  const database = await readDatabase(paths.database)
  const bundle = createSupportBundle({ config, database })
  return { config: bundle.config, database: bundle.database }
}

async function present(filename: string) {
  return stat(filename).then(
    () => true,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
        ? false
        : ("unavailable" as const),
  )
}

async function readDatabase(filename: string) {
  if (filename === ":memory:") return { availability: "memory" }
  const exists = await present(filename)
  if (exists === false) return { availability: "missing" }
  if (exists === "unavailable") return { availability: "unavailable" }
  try {
    const before = await databaseSnapshot(filename)
    if (before.busy) return { availability: "unavailable" }
    const { DatabaseSync } = await import("node:sqlite")
    const uri = pathToFileURL(filename)
    uri.searchParams.set("mode", "ro")
    uri.searchParams.set("immutable", "1")
    // Ordinary readOnly connections can create WAL/SHM or update existing SHM.
    // Immutable access has no such side effects, but must never ignore live journals.
    const db = new DatabaseSync(uri.href, { readOnly: true })
    const result = (() => {
      try {
        return summarizeDatabase(db)
      } finally {
        db.close()
      }
    })()
    const after = await databaseSnapshot(filename)
    return after.busy || before.identity !== after.identity ? { availability: "unavailable" } : result
  } catch {
    return { availability: "unavailable" }
  }
}

async function databaseSnapshot(filename: string) {
  const file = await stat(filename, { bigint: true })
  const journals = await Promise.all(
    ["-wal", "-journal"].map((suffix) =>
      stat(`${filename}${suffix}`).then(
        (item) => item.size > 0,
        (error: unknown) =>
          !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"),
      ),
    ),
  )
  return {
    identity: `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`,
    busy: journals.some(Boolean),
  }
}

function summarizeDatabase(db: DatabaseSync) {
  const schema = db.prepare("PRAGMA schema_version").get()
  const common = { availability: "available", schemaVersion: schema?.schema_version }
  // A malformed journal must not hide the otherwise readable schema version.
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('migration', '__drizzle_migrations')")
      .all()
    if (tables.some((item) => item.name === "migration")) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS count, MAX(CASE WHEN length(id) >= 15 AND substr(id,15,1) = '_' AND substr(id,1,14) NOT GLOB '*[^0-9]*' THEN substr(id,1,14) END) AS latest FROM migration",
        )
        .get()
      if (row?.count !== 0 || !tables.some((item) => item.name === "__drizzle_migrations"))
        return {
          ...common,
          migrationFormat: "current",
          appliedCount: row?.count,
          latestMigration: row?.latest ? Number(row.latest) : null,
        }
    }
    if (tables.some((item) => item.name === "__drizzle_migrations")) {
      const named = db
        .prepare("PRAGMA table_info('__drizzle_migrations')")
        .all()
        .some((item) => item.name === "name")
      const row = db
        .prepare(
          named
            ? "SELECT COUNT(*) AS count, MAX(CASE WHEN length(name) >= 15 AND substr(name,15,1) = '_' AND substr(name,1,14) NOT GLOB '*[^0-9]*' THEN substr(name,1,14) END) AS latest FROM __drizzle_migrations"
            : "SELECT COUNT(*) AS count, strftime('%Y%m%d%H%M%S', MAX(CASE WHEN typeof(created_at) = 'integer' AND created_at BETWEEN 946684800000 AND 4102444799999 THEN created_at END) / 1000, 'unixepoch') AS latest FROM __drizzle_migrations",
        )
        .get()
      return {
        ...common,
        migrationFormat: "legacy",
        appliedCount: row?.count,
        latestMigration: row?.latest ? Number(row.latest) : null,
      }
    }
  } catch {
    /* Keep only the readable schema summary. */
  }
  return common
}
