export type SanitizedRecord = {
  kind: "config" | "tui" | "session" | "project" | "desktop"
  value: unknown
  discardedPaths: readonly string[]
}

type RecordKind = SanitizedRecord["kind"]

export class MigrationSanitizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeMigrationSanitizeError"
  }
}

const ROOT_FIELDS: Record<RecordKind, ReadonlySet<string>> = {
  config: new Set(["theme", "language", "username", "keybinds", "snapshot", "logLevel"]),
  tui: new Set(["theme", "language", "keybinds", "scrollSpeed", "diffStyle"]),
  session: new Set([
    "id",
    "sessionID",
    "messageID",
    "projectID",
    "parentID",
    "role",
    "type",
    "text",
    "content",
    "title",
    "version",
    "time",
    "summary",
    "messages",
    "parts",
  ]),
  project: new Set(["id", "worktree", "vcs", "name", "icon", "time"]),
  desktop: new Set(["theme", "language", "zoom", "sidebar", "window"]),
}

const NESTED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  time: new Set(["created", "updated", "archived"]),
  summary: new Set(["additions", "deletions", "files"]),
  messages: new Set(["id", "sessionID", "role", "text", "content", "time", "parts"]),
  parts: new Set(["id", "sessionID", "messageID", "type", "text", "content", "time"]),
  icon: new Set(["url", "override"]),
  window: new Set(["width", "height", "maximized"]),
}

const DYNAMIC_MAPS = new Set(["keybinds", "sidebar"])
const USER_TEXT = new Set(["title", "text", "content", "name", "worktree"])
const ACTIVE_KEY =
  /(?:^|[_-])(?:provider|model|plugin|mcp|skill|share|update|command|exec|executable|argv|binary|launcher|server|url|baseurl|host|origin|endpoint|schema|runtime|fallback|token|secret|password|authorization)(?:$|[_-])/i

export function sanitizeMigrationRecord(input: { kind: RecordKind; value: unknown }): SanitizedRecord {
  if (!plainRecord(input.value)) throw new MigrationSanitizeError("A migration record must be a plain record.")
  const discarded = new Set<string>()
  const value = project(input.value, ROOT_FIELDS[input.kind], "", discarded)
  return { kind: input.kind, value, discardedPaths: [...discarded].toSorted() }
}

function project(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  prefix: string,
  discarded: Set<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const current = prefix ? `${prefix}.${key}` : key
      if (!fields.has(key) || ACTIVE_KEY.test(key)) {
        discarded.add(current)
        return []
      }
      return [[key, sanitizeValue(item, key, current, discarded)] as const]
    }),
  )
}

function sanitizeValue(value: unknown, field: string, current: string, discarded: Set<string>): unknown {
  if (typeof value === "string") {
    if (field === "worktree" && !value.startsWith("/"))
      throw new MigrationSanitizeError("A retained project path must be absolute.")
    if (!USER_TEXT.has(field) && credentialShaped(value)) {
      throw new MigrationSanitizeError("A retained migration value was credential-shaped.")
    }
    if (!USER_TEXT.has(field) && forbiddenIdentity(value)) {
      throw new MigrationSanitizeError("A retained migration value contained a forbidden active identity.")
    }
    return value
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    const fields = NESTED_FIELDS[field]
    if (!fields) return value.filter((item) => primitive(item))
    return value.flatMap((item, index) => {
      if (!plainRecord(item)) {
        discarded.add(`${current}.${index}`)
        return []
      }
      return [project(item, fields, `${current}.${index}`, discarded)]
    })
  }
  if (!plainRecord(value)) throw new MigrationSanitizeError("A retained migration value had an unsupported shape.")
  if (DYNAMIC_MAPS.has(field)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return [[key, item]]
        discarded.add(`${current}.${key}`)
        return []
      }),
    )
  }
  const fields = NESTED_FIELDS[field]
  if (!fields) {
    discarded.add(current)
    return undefined
  }
  return project(value, fields, current, discarded)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function primitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
}

function credentialShaped(value: string) {
  return /(?:bearer\s+[a-z0-9._-]{12,}|(?:access|refresh|id)[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|password|private[-_ ]?key|\beyJ[a-z0-9_-]{12,})/i.test(
    value,
  )
}

function forbiddenIdentity(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase()
  return /(?:^|[^a-z0-9])(?:opencode\.ai|opncd\.ai|models\.dev)(?:[^a-z0-9]|$)/.test(normalized)
}

export * as MigrationSanitize from "./sanitize"
