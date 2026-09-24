import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Schema } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { nativeT } from "./native-translations"

type Row = Record<string, SQLInputValue>
const encode = Schema.encodeSync(SessionMessage.Message)
const decode = (value: unknown) => Schema.decodeUnknownSync(SessionMessage.Message)(JSON.parse(JSON.stringify(value)))
const fields = {
  project: [
    "id",
    "worktree",
    "vcs",
    "name",
    "icon_url",
    "icon_color",
    "time_created",
    "time_updated",
    "time_initialized",
    "sandboxes",
  ],
  session: [
    "id",
    "project_id",
    "parent_id",
    "slug",
    "directory",
    "title",
    "version",
    "summary_additions",
    "summary_deletions",
    "summary_files",
    "summary_diffs",
    "time_created",
    "time_updated",
    "time_archived",
  ],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
} as const

function insert(db: DatabaseSync, table: keyof typeof fields, row: Row) {
  const keys = fields[table].filter((key) => row[key] !== undefined)
  db.prepare(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
  ).run(...keys.map((key) => row[key]!))
}

function json(value: SQLInputValue): unknown {
  if (typeof value !== "string") throw new Error("INVALID_CHAT_DATA")
  return JSON.parse(value)
}

// Keep the original message/part rows as well as a validated projection for the
// new interface. Imported tool calls are history, never pending work to resume.
export function projectChatMessage(row: Row, parts: Row[]) {
  const info = json(row.data!) as SessionV1.Info
  const values = parts.map((part) => ({ ...(json(part.data!) as SessionV1.Part), id: String(part.id) }))
  const base = { id: row.id, time: { created: Number(row.time_created) } }
  if (info.role === "user")
    return encode(
      decode({
        ...base,
        type: "user",
        text: values
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        files: values
          .filter((part) => part.type === "file")
          .map((part) => ({ uri: part.url, mime: part.mime, name: part.filename })),
        agents: values.filter((part) => part.type === "agent").map((part) => ({ name: part.name })),
      }),
    )
  if (info.role !== "assistant") throw new Error("INVALID_CHAT_ROLE")
  return encode(
    decode({
      ...base,
      type: "assistant",
      agent: info.agent ?? info.mode ?? "build",
      model: { id: info.modelID, providerID: info.providerID, variant: info.variant },
      finish: info.finish,
      cost: info.cost,
      tokens: info.tokens,
      error: info.error
        ? {
            type: "unknown",
            message:
              "message" in info.error.data ? info.error.data.message : nativeT("desktop.chatImport.previousError"),
          }
        : undefined,
      time: { created: Number(row.time_created), completed: info.time?.completed ?? Number(row.time_updated) },
      content: values.flatMap<unknown>((part) => {
        if (part.type === "text" || part.type === "reasoning")
          return [{ type: part.type, id: part.id, text: part.text }]
        if (part.type !== "tool") return []
        const state = part.state
        const completed = state?.status === "completed"
        const time = "time" in state ? state.time : undefined
        return [
          {
            type: "tool",
            id: part.callID,
            name: part.tool,
            time: {
              created: time?.start ?? Number(row.time_created),
              completed: time && "end" in time ? time.end : Number(row.time_updated),
            },
            state: {
              status: completed ? "completed" : "error",
              input: state.input ?? {},
              structured: "metadata" in state ? (state.metadata ?? {}) : {},
              content: completed ? [{ type: "text", text: state.output ?? "" }] : [],
              ...(completed
                ? {
                    attachments: state.attachments?.map((file: { url: string; mime: string; filename?: string }) => ({
                      uri: file.url,
                      mime: file.mime,
                      name: file.filename,
                    })),
                  }
                : {
                    error: {
                      type: "unknown",
                      message: state.status === "error" ? state.error : nativeT("desktop.chatImport.interrupted"),
                    },
                  }),
            },
          },
        ]
      }),
    }),
  )
}

function normalize(value: SQLInputValue) {
  return typeof value === "string" && process.platform === "win32" ? value.replaceAll("\\", "/") : value
}

export async function importPreviousChats(source: string, destination: string) {
  const sourceStat = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!sourceStat) return { imported: 0, skipped: 0 }
  const targetStat = await lstat(destination)
  if (
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    sourceStat.nlink !== 1 ||
    !targetStat.isFile() ||
    targetStat.isSymbolicLink()
  )
    throw new Error("UNSAFE_CHAT_DATABASE")
  const identity = await realpath(source)
  if (
    identity === (await realpath(destination)) ||
    (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
  )
    return { imported: 0, skipped: 0 }
  const target = new DatabaseSync(destination)
  try {
    target.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF")
    target.exec(
      "CREATE TABLE IF NOT EXISTS bharatcode_chat_import (source TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)",
    )
    if (target.prepare("SELECT 1 FROM bharatcode_chat_import WHERE source=?").get(identity))
      return { imported: 0, skipped: 0 }
    const origin = new DatabaseSync(source, { readOnly: true })
    try {
      origin.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN")
      const integrity = origin.prepare("PRAGMA quick_check").all()
      if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok") throw new Error("INVALID_CHAT_DATABASE")
      // Snapshot reads include committed WAL data. Never use an immutable URI
      // or copy just the .db file while the previous app may still be running.
      const projects = origin.prepare("SELECT * FROM project").all() as Row[]
      const sessions = origin.prepare("SELECT * FROM session ORDER BY time_created, id").all() as Row[]
      const hasProjection = Boolean(
        origin.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message'").get(),
      )
      const folder = join(dirname(destination), "chat-import-backups")
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await backup(target, join(folder, `${randomUUID()}.db`))
      target.exec("BEGIN IMMEDIATE")
      try {
        if (target.prepare("SELECT 1 FROM bharatcode_chat_import WHERE source=?").get(identity)) {
          target.exec("ROLLBACK")
          return { imported: 0, skipped: 0 }
        }
        let imported = 0
        let skipped = 0
        for (const session of sessions) {
          if (target.prepare("SELECT 1 FROM session WHERE id=?").get(session.id!)) {
            skipped++
            continue
          }
          const project = projects.find((item) => item.id === session.project_id)
          if (!project) throw new Error("MISSING_CHAT_PROJECT")
          if (!target.prepare("SELECT 1 FROM project WHERE id=?").get(project.id!))
            insert(target, "project", {
              ...project,
              worktree: normalize(project.worktree!),
              sandboxes: JSON.stringify((json(project.sandboxes!) as string[]).map(normalize)),
            })
          insert(target, "session", { ...session, directory: normalize(session.directory!) })
          const messages = origin
            .prepare("SELECT * FROM message WHERE session_id=? ORDER BY time_created, id")
            .all(session.id!) as Row[]
          const projections = new Map<
            string,
            { message: ReturnType<typeof projectChatMessage>; updated: SQLInputValue }
          >()
          let seq = 0
          for (const message of messages) {
            const parts = origin
              .prepare("SELECT * FROM part WHERE message_id=? ORDER BY time_created, id")
              .all(message.id!) as Row[]
            if (parts.some((part) => part.session_id !== session.id)) throw new Error("INVALID_CHAT_PART")
            const projected = projectChatMessage(message, parts)
            insert(target, "message", message)
            for (const part of parts) insert(target, "part", part)
            projections.set(projected.id, { message: projected, updated: message.time_updated! })
          }
          // Transitional releases stored model/agent changes only here. Newer
          // transcripts may also be here. Preserve both, validating rather
          // than treating an empty legacy message table as an empty chat.
          if (hasProjection)
            for (const row of origin
              .prepare("SELECT * FROM session_message WHERE session_id=?")
              .all(session.id!) as Row[]) {
              const id = String(row.id)
              const projected = encode(
                decode({
                  ...(json(row.data!) as object),
                  id: id.startsWith("msg_") ? id : `msg_import_${createHash("sha256").update(id).digest("hex")}`,
                  type: row.type,
                }),
              )
              projections.set(projected.id, { message: projected, updated: row.time_updated! })
            }
          const ordered = [...projections.values()].sort(
            (a, b) => a.message.time.created - b.message.time.created || a.message.id.localeCompare(b.message.id),
          )
          for (const projected of ordered) {
            const { id, type, ...data } = projected.message
            target
              .prepare(
                "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)",
              )
              .run(id, session.id!, type, ++seq, data.time.created, projected.updated, JSON.stringify(data))
          }
          // Reserve projection order so continuing an imported chat cannot
          // collide with its historical message sequence.
          target.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?,?)").run(session.id!, seq)
          imported++
        }
        target
          .prepare("INSERT INTO bharatcode_chat_import (source,time_completed) VALUES (?,?)")
          .run(identity, Date.now())
        target.exec("COMMIT")
        return { imported, skipped }
      } catch (error) {
        target.exec("ROLLBACK")
        throw error
      }
    } finally {
      origin.close()
    }
  } finally {
    target.close()
  }
}
