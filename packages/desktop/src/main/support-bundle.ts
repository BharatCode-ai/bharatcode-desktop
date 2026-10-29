import type { App, NetLog, Shell } from "electron"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, platform, arch, release, totalmem, freemem, cpus, uptime } from "node:os"
import { join, dirname } from "node:path"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { Global } from "@opencode-ai/core/global"

function getElectron(): {
  app?: App
  netLog?: NetLog
  shell?: Shell
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const el = require("electron")
    if (typeof el === "object" && el !== null && "app" in el) {
      return el
    }
  } catch {}
  return {}
}

const electron = getElectron()
const app = electron.app
const netLog = electron.netLog
const shell = electron.shell

export interface RedactionOptions {
  homeDir?: string
  usernames?: string[]
}

// A denylist cannot be complete; anything not matched here still ships in the logs.
const SECRET_PATTERNS: { pattern: RegExp; replacement: string | ((...match: string[]) => string) }[] = [
  // URL credentials; the password may itself contain "@" or ":"
  { pattern: /([a-zA-Z0-9+.-]+:\/\/)([^:\s@/]+):([^\s/]+)@/gi, replacement: "$1$2:[REDACTED]@" },
  // Private repository URLs (Git/HTTPS/SSH) - must run BEFORE email and URL patterns
  {
    pattern: /(?:git\+ssh:\/\/|git@|ssh:\/\/git@)[a-zA-Z0-9._-]+[:/][a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:\.git)?/gi,
    replacement: "[REDACTED_REPO_URL]",
  },
  {
    pattern:
      /https?:\/\/(?:[^:\s@/]+:[^:\s@/]+@)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:\.git)?/gi,
    replacement: "[REDACTED_REPO_URL]",
  },
  // Private keys, including a truncated one with no END marker
  {
    pattern: /-----BEGIN[ A-Z0-9_-]+PRIVATE KEY-----[\s\S]*?(?:-----END[ A-Z0-9_-]+PRIVATE KEY-----|$)/gi,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // Whole header values, whatever the auth scheme
  {
    pattern: /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key)(\s*:\s*)[^\r\n]+/gi,
    replacement: "$1$2[REDACTED]",
  },
  // Bearer, Basic, and Token authentication headers
  { pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, replacement: "$1 [REDACTED]" },
  // JSON authorization and auth token keys
  {
    pattern:
      /(["'](?:(?:proxy[-_]?)?authorization|auth[-_]?token|auth[-_]?header)["']\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&{}"']+)/gi,
    replacement: '$1"[REDACTED]"',
  },
  // API keys (Anthropic, OpenAI-style, GitHub, Slack, Google, AWS)
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { pattern: /\bsk-[a-zA-Z0-9_-]{8,}/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { pattern: /gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /xox[baprs](?:-[0-9a-zA-Z]+){2,}/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { pattern: /AIza[0-9A-Za-z_-]{20,}/g, replacement: "[REDACTED_GOOGLE_KEY]" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, replacement: "[REDACTED_JWT]" },
  // OAuth codes and keys in query strings
  { pattern: /([?&](?:code|key|sig|signature)=)[^&\s#]+/gi, replacement: "$1[REDACTED]" },
  // Generic key-value secrets in JSON, query params, or logs
  {
    pattern:
      /((?:[\w-]*[-_])?(?:secret|password|passwd|api[-_]?key|access[-_]?key|token|(?:proxy[-_]?)?authorization|auth[-_]?token|auth[-_]?key|credential|cookie)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!\[REDACTED)[^\s,;&{}"']+)/gi,
    replacement: (_match, head, value) =>
      `${head}${value[0] === '"' || value[0] === "'" ? `${value[0]}[REDACTED]${value[0]}` : "[REDACTED]"}`,
  },
  // Personal identifiers
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[REDACTED_EMAIL]" },
  { pattern: /\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: "[REDACTED_IP]" },
  { pattern: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, replacement: "[REDACTED_MAC]" },
  // Sensitive prompt text or chat content in logs
  {
    pattern:
      /(["']?(?:prompt|content|user_message|chat_text|system_prompt)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi,
    replacement: '$1"[REDACTED_PROMPT]"',
  },
  {
    pattern:
      /(["']?(?:prompt|content|user_message|chat_text|system_prompt)["']?\s*[:=]\s*["'])(?:(?=(\\?))\2[\s\S])*?(["'])/gi,
    replacement: "$1[REDACTED_PROMPT]$3",
  },
]

export function redactString(text: string, options?: RedactionOptions): string {
  if (!text || typeof text !== "string") return text

  let result = text

  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result =
      typeof replacement === "string" ? result.replace(pattern, replacement) : result.replace(pattern, replacement)
  }

  // Home directory and username scrubbing
  const userHome = options?.homeDir ?? homedir()
  if (userHome && userHome.length > 2) {
    const escapedHome = userHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(escapedHome, "gi"), "<USER_HOME>")

    const forwardSlashHome = userHome.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(forwardSlashHome, "gi"), "<USER_HOME>")
  }

  // Fallback pattern for Windows and Unix user directory paths
  result = result.replace(/[A-Z]:\\Users\\[^\s\\"',;]+/gi, "<USER_HOME>")
  result = result.replace(/[A-Z]:\/Users\/[^\s\/\"',;]+/gi, "<USER_HOME>")
  result = result.replace(/\/home\/[a-zA-Z0-9_.-]+/g, "<USER_HOME>")
  result = result.replace(/\/Users\/[a-zA-Z0-9_.-]+/g, "<USER_HOME>")
  result = result.replace(/\/root(?=\/|\s|$)/g, "<USER_HOME>")

  return result
}

export function redactObject<T>(obj: T, options?: RedactionOptions): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "string") return redactString(obj, options) as unknown as T
  if (typeof obj !== "object") return obj

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, options)) as unknown as T
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase()
    const isAuthor = lowerKey === "author" || lowerKey.startsWith("author_")
    if (
      !isAuthor &&
      /(secret|password|passwd|credential|api[-_]?key|access[-_]?key|cookie|bearer|auth|token(?!s))/i.test(key)
    ) {
      result[key] = "[REDACTED]"
    } else if (/^(prompt|content)$/i.test(key)) {
      result[key] = "[REDACTED_PROMPT]"
    } else {
      result[key] = redactObject(value, options)
    }
  }
  return result as T
}

export interface DatabaseHealthResult {
  path: string
  exists: boolean
  integrityOk: boolean
  checks: string[]
  tableCounts: Record<string, number>
  error?: string
}

interface SqliteAdapter {
  quickCheck: () => string[]
  getTables: () => string[]
  getCount: (table: string) => number
  close: () => void
}

async function openSqliteAdapter(targetPath: string): Promise<SqliteAdapter> {
  if (typeof (globalThis as any).Bun !== "undefined") {
    const bunSqlite = "bun:sqlite"
    const { Database } = (await import(bunSqlite)) as any
    const db = new Database(targetPath, { readonly: true })
    return {
      quickCheck: () => {
        const rows = db.query("PRAGMA quick_check").all() as Record<string, string>[]
        return rows.map((r: Record<string, string>) => String(Object.values(r)[0] ?? "unknown"))
      },
      getTables: () => {
        const rows = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
        return rows.map((r: { name: string }) => String(r.name))
      },
      getCount: (table: string) => {
        try {
          const row = db.query(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number } | null
          return row?.count ?? 0
        } catch {
          return -1
        }
      },
      close: () => {
        db.close()
      },
    }
  }

  const sqliteModule = (await import("node:sqlite")) as any
  const DatabaseClass = sqliteModule.DatabaseSync
  const db = new DatabaseClass(targetPath, { readOnly: true })
  return {
    quickCheck: () => {
      const rows = db.prepare("PRAGMA quick_check").all() as Record<string, string>[]
      return rows.map((r: any) => String(Object.values(r)[0] ?? "unknown"))
    },
    getTables: () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      return rows.map((r: any) => String(r.name))
    },
    getCount: (table: string) => {
      try {
        const row = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number } | null
        return row?.count ?? 0
      } catch {
        return -1
      }
    },
    close: () => {
      db.close()
    },
  }
}

export async function checkDatabaseHealth(dbPath?: string): Promise<DatabaseHealthResult> {
  const targetPath = dbPath ?? process.env.OPENCODE_DB ?? Global.Path.database
  if (!existsSync(targetPath)) {
    return {
      path: redactString(targetPath),
      exists: false,
      integrityOk: false,
      checks: ["DATABASE_NOT_FOUND"],
      tableCounts: {},
    }
  }

  try {
    const adapter = await openSqliteAdapter(targetPath)
    try {
      const checkResults = adapter.quickCheck()
      const integrityOk = checkResults.length === 1 && checkResults[0] === "ok"

      const tables = adapter.getTables()
      const tableCounts: Record<string, number> = {}
      for (const table of tables) {
        tableCounts[table] = adapter.getCount(table)
      }

      return {
        path: redactString(targetPath),
        exists: true,
        integrityOk,
        checks: checkResults,
        tableCounts,
      }
    } finally {
      adapter.close()
    }
  } catch (err) {
    return {
      path: redactString(targetPath),
      exists: true,
      integrityOk: false,
      checks: ["DATABASE_CHECK_FAILED"],
      tableCounts: {},
      error: redactString(err instanceof Error ? err.message : String(err)),
    }
  }
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

type BundleEntry = { name: string; data: Buffer }

export function collectRedactedLogs(dir: string, prefix: string): BundleEntry[] {
  if (!existsSync(dir)) return []
  const result: BundleEntry[] = []
  const cutoff = Date.now() - 24 * 60 * 60 * 1000

  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const file = join(current, entry)
      try {
        const info = lstatSync(file)
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) {
          walk(file)
          continue
        }
        if (info.mtimeMs < cutoff || info.size > 20 * 1024 * 1024) continue
        if (file.endsWith(".heapsnapshot")) continue

        const raw = readFileSync(file, "utf8")
        const scrubbed = redactString(raw)
        const relName = join(prefix, file.slice(dir.length + 1)).replace(/\\/g, "/")
        result.push({ name: relName, data: Buffer.from(scrubbed, "utf8") })
      } catch {
        continue
      }
    }
  }

  walk(dir)
  return result
}

export interface SupportBundleResult {
  outputPath: string
  fileCount: number
  databaseHealth: DatabaseHealthResult
}

export async function generateSupportBundle(options?: {
  outputDir?: string
  dbPath?: string
}): Promise<SupportBundleResult> {
  const restartNetLog = typeof netLog !== "undefined" && netLog.currentlyLogging
  if (restartNetLog) {
    await netLog.stopLogging().catch(() => {})
  }

  const downloads = options?.outputDir ?? (app ? app.getPath("downloads") : homedir())
  const outputPath = join(downloads, `bharatcode-support-bundle-${stamp()}.zip`)

  try {
    const dbHealth = await checkDatabaseHealth(options?.dbPath)

    const systemInfo = {
      timestamp: new Date().toISOString(),
      app: app
        ? {
            name: app.getName(),
            version: app.getVersion(),
            isPackaged: app.isPackaged,
            locale: app.getLocale(),
          }
        : { name: "bharatcode-desktop", version: "unknown", isPackaged: false },
      system: {
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        uptimeSeconds: Math.round(uptime()),
        cpuCores: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
      },
    }

    const manifest = {
      generated: new Date().toISOString(),
      type: "bharatcode-support-bundle",
      formatVersion: "1.0",
      systemOverview: systemInfo,
      databaseIntegrity: dbHealth.integrityOk,
    }

    // Collect sanitized configuration if present
    const configPath = Global.Path.config
    let sanitizedConfig: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        const configFile = join(configPath, "config.json")
        if (existsSync(configFile)) {
          const rawConfig = JSON.parse(readFileSync(configFile, "utf8"))
          sanitizedConfig = redactObject(rawConfig)
        }
      } catch {
        sanitizedConfig = { error: "Failed to read configuration file" }
      }
    }

    // Allowlisted metadata structure (following #59 design)
    const supportBundleMetadata = {
      manifest,
      system: systemInfo.system,
      database: {
        path: dbHealth.path,
        exists: dbHealth.exists,
        integrityOk: dbHealth.integrityOk,
        checks: dbHealth.checks,
        tableCounts: dbHealth.tableCounts,
      },
      config: {
        exists: existsSync(join(configPath, "config.json")),
        sanitized: sanitizedConfig,
      },
    }

    const logsDir = app ? join(app.getPath("userData"), "logs") : Global.Path.log
    const serverLogsDir = Global.Path.log

    const entries: BundleEntry[] = [
      { name: "support-bundle.json", data: Buffer.from(JSON.stringify(supportBundleMetadata, null, 2)) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: "system-info.json", data: Buffer.from(JSON.stringify(systemInfo, null, 2)) },
      { name: "database-health.json", data: Buffer.from(JSON.stringify(dbHealth, null, 2)) },
      { name: "config-sanitized.json", data: Buffer.from(JSON.stringify(sanitizedConfig, null, 2)) },
      ...collectRedactedLogs(logsDir, "logs/desktop"),
      ...collectRedactedLogs(serverLogsDir, "logs/server"),
    ]

    const writer = new ZipWriter(new BlobWriter("application/zip"))
    for (const entry of entries) {
      await writer.add(entry.name, new BlobReader(new Blob([new Uint8Array(entry.data)])))
    }
    const zip = await writer.close()
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, Buffer.from(await zip.arrayBuffer()), { mode: 0o600 })

    return {
      outputPath,
      fileCount: entries.length,
      databaseHealth: dbHealth,
    }
  } finally {
    if (restartNetLog && app && netLog) {
      const netLogPath = join(app.getPath("userData"), "logs", "network.netlog")
      await netLog.startLogging(netLogPath, { captureMode: "default", maxFileSize: 20 * 1024 * 1024 }).catch(() => {})
    }
  }
}

export async function exportSupportBundle(options?: { outputDir?: string }): Promise<string> {
  const result = await generateSupportBundle(options)
  if (typeof shell !== "undefined" && shell.showItemInFolder) {
    shell.showItemInFolder(result.outputPath)
  }
  return result.outputPath
}
