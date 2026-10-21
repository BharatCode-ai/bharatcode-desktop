import { stat } from "node:fs/promises"
import path from "node:path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { createSupportBundle, type SupportMetadata } from "./support-bundle"
import type { Channel } from "./branding"

type Input = { channel: Channel; platform: NodeJS.Platform; home: string; temp: string; env: NodeJS.ProcessEnv }

// Pure resolver: importing Global or Database would initialize/migrate storage.
export function resolveSupportPaths(input: Input) {
  const paths = StoragePaths.resolve(input)
  const api = input.platform === "win32" ? path.win32 : path.posix
  return {
    ...paths,
    config: input.env.BHARATCODE_CONFIG_DIR ?? input.env.OPENCODE_CONFIG_DIR ?? paths.config,
    override: input.env.OPENCODE_CONFIG,
    database: input.env.OPENCODE_DB === ":memory:" ? ":memory:" : input.env.OPENCODE_DB ? api.isAbsolute(input.env.OPENCODE_DB) ? input.env.OPENCODE_DB : api.join(paths.data, input.env.OPENCODE_DB) : paths.database,
  }
}

export async function collectSupportMetadata(input: Input): Promise<SupportMetadata> {
  const paths = resolveSupportPaths(input)
  const api = input.platform === "win32" ? path.win32 : path.posix
  const config = Object.fromEntries(await Promise.all([
    ["directory", paths.config], ["globalJson", api.join(paths.config, "opencode.json")],
    ["globalJsonc", api.join(paths.config, "opencode.jsonc")], ["globalLegacy", api.join(paths.config, "config.json")],
    ["override", paths.override], ["authStore", paths.auth],
  ].map(async ([name, filename]) => [name, filename ? await present(filename) : false])))
  const database = await readDatabase(paths.database)
  const bundle = createSupportBundle({ config, database })
  return { config: bundle.config, database: bundle.database }
}

async function present(filename: string) {
  return stat(filename).then(() => true, (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? false : "unavailable" as const,
  )
}

async function readDatabase(filename: string) {
  if (filename === ":memory:") return { availability: "memory" }
  const exists = await present(filename)
  if (exists === false) return { availability: "missing" }
  if (exists === "unavailable") return { availability: "unavailable" }
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(filename, { readOnly: true, timeout: 100 })
    try {
      const schema = db.prepare("PRAGMA schema_version").get()
      const common = { availability: "available", schemaVersion: schema?.schema_version }
      // A malformed journal must not hide the otherwise readable schema version.
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('migration', '__drizzle_migrations')").all()
        if (tables.some((item) => item.name === "migration")) {
          const row = db.prepare("SELECT COUNT(*) AS count, MAX(CASE WHEN length(id) >= 15 AND substr(id,15,1) = '_' AND substr(id,1,14) NOT GLOB '*[^0-9]*' THEN substr(id,1,14) END) AS latest FROM migration").get()
          return { ...common, migrationFormat: "current", appliedCount: row?.count, latestMigration: row?.latest ? Number(row.latest) : null }
        }
        if (tables.some((item) => item.name === "__drizzle_migrations")) {
          const named = db.prepare("PRAGMA table_info('__drizzle_migrations')").all().some((item) => item.name === "name")
          const row = db.prepare(named
            ? "SELECT COUNT(*) AS count, MAX(CASE WHEN length(name) >= 15 AND substr(name,15,1) = '_' AND substr(name,1,14) NOT GLOB '*[^0-9]*' THEN substr(name,1,14) END) AS latest FROM __drizzle_migrations"
            : "SELECT COUNT(*) AS count, strftime('%Y%m%d%H%M%S', MAX(CASE WHEN typeof(created_at) = 'integer' AND created_at BETWEEN 946684800000 AND 4102444799999 THEN created_at END) / 1000, 'unixepoch') AS latest FROM __drizzle_migrations").get()
          return { ...common, migrationFormat: "legacy", appliedCount: row?.count, latestMigration: row?.latest ? Number(row.latest) : null }
        }
      } catch { /* Keep only the readable schema summary. */ }
      return common
    } finally { db.close() }
  } catch { return { availability: "unavailable" } }
}
