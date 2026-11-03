// Project memory: one private Markdown file per project, outside the repo. save_memory
// follows Qwen Code's memory tool (Apache-2.0, QwenLM/qwen-code); the per-turn size
// budget follows Engram (MIT, kenz1117/dsh-engram).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

// UTF-8 bytes rather than characters, so Indic and other non-Latin facts stay within
// about 1,000 tokens per chat as well.
export const BUDGET = 4_000
export const MAX_FACT = 500
const HEADING = "## Remembered facts"
const ARCHIVE = "## Archived facts"
const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY|\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./

type Memory = { facts: string[]; archived: string[] }
type Result = { saved: boolean; error: boolean; message: string }

const factSchema = {
  type: "string",
  description: `One short standalone sentence, at most ${MAX_FACT} characters, for example "This project uses Bun, not npm."`,
}
const numberSchema = { type: "integer", minimum: 1, description: "The fact's number in the save_memory list." }

// MCP clients read server instructions only when they connect, but they re-read tool
// lists on tools/list_changed. The current facts therefore live in save_memory's
// description so a fact saved in one chat reaches the next chat without a reload.
export function tools(facts: string[]) {
  return [
    {
      name: "save_memory",
      description: [
        "Saves one stable fact about this project so it is remembered in future chats.",
        "Use it when the user asks you to remember something, or when you learn a durable project convention, such as how to build or test, which tools or package manager to use, where things live, or a preference the user stated.",
        "Do not save secrets, credentials, personal data, temporary task state, conversation history, or anything already written in AGENTS.md. Write one short, standalone sentence.",
        "",
        listing(facts),
      ].join("\n"),
      inputSchema: schema({ fact: factSchema }),
    },
    {
      name: "update_memory",
      description:
        "Replaces a saved project fact that is wrong or out of date. Use the fact's number from the save_memory list.",
      inputSchema: schema({ number: numberSchema, fact: factSchema }),
    },
    {
      name: "forget_memory",
      description:
        "Removes a saved project fact that is wrong or no longer true. Use the fact's number from the save_memory list.",
      inputSchema: schema({ number: numberSchema }),
    },
  ]
}

export function instructions(file: string) {
  return [
    "Project memory: facts saved in earlier chats about this project are listed, numbered, in the save_memory tool description. Read them before you start.",
    "They are hints and may be out of date. AGENTS.md, the user's instructions and the actual code always take priority over a remembered fact.",
    "Use save_memory for new stable facts, update_memory to correct a fact, and forget_memory to remove one that is wrong.",
    `The user can view or edit the memory file at ${shorten(file)}.`,
  ].join("\n")
}

export async function locate(root: string, cwd: string) {
  return path.join(root, await project(cwd), "MEMORY.md")
}

export async function facts(file: string) {
  return (await read(file)).facts
}

export async function save(file: string, input: string): Promise<Result> {
  const fact = input.trim()
  const problem = check(fact)
  if (problem) return { saved: false, error: true, message: problem }
  const memory = await read(file)
  if (memory.facts.some((item) => same(item, fact)))
    return { saved: false, error: false, message: "This fact is already saved." }
  await write(file, { ...memory, facts: [...memory.facts, fact] })
  return { saved: true, error: false, message: saved([...memory.facts, fact]) }
}

export async function update(file: string, number: number, input: string): Promise<Result> {
  const fact = input.trim()
  const problem = check(fact)
  if (problem) return { saved: false, error: true, message: problem }
  const memory = await read(file)
  const old = memory.facts[number - 1]
  if (!Number.isInteger(number) || old === undefined) return missing(number)
  if (memory.facts.some((item, index) => index !== number - 1 && same(item, fact)))
    return { saved: false, error: false, message: "This fact is already saved." }
  const next = memory.facts.map((item, index) => (index === number - 1 ? fact : item))
  await write(file, { facts: next, archived: [...memory.archived, archive(old, "replaced")] })
  return { saved: true, error: false, message: saved(next) }
}

export async function forget(file: string, number: number): Promise<Result> {
  const memory = await read(file)
  const old = memory.facts[number - 1]
  if (!Number.isInteger(number) || old === undefined) return missing(number)
  const next = memory.facts.filter((_, index) => index !== number - 1)
  await write(file, { facts: next, archived: [...memory.archived, archive(old, "forgotten")] })
  return { saved: true, error: false, message: `Forgotten. The fact list is renumbered.\n\n${listing(next)}` }
}

function listing(facts: string[]) {
  // Keep the newest facts when the file outgrows the per-chat budget, but keep their
  // real numbers so update_memory and forget_memory still point at the right line.
  const shown = facts
    .map((fact, index) => `[${index + 1}] ${fact}`)
    .reduceRight<string[]>((kept, line) => (bytes([line, ...kept].join("\n")) > BUDGET ? kept : [line, ...kept]), [])
  const hidden = facts.length - shown.length
  return [
    "Saved project facts:",
    shown.length ? shown.join("\n") : "No facts saved yet.",
    ...(hidden ? [`${hidden} older facts are not listed to save space. Ask the user to tidy the memory file.`] : []),
  ].join("\n")
}

function saved(facts: string[]) {
  return `Saved. It is listed in save_memory from now on, including in new chats.\n\n${listing(facts)}`
}

function missing(number: number): Result {
  return { saved: false, error: true, message: `There is no saved fact number ${number}. Check the save_memory list.` }
}

function archive(fact: string, reason: string) {
  return `${fact} (${reason} ${new Date().toISOString().slice(0, 10)})`
}

function check(fact: string) {
  if (!fact) return "The fact is empty."
  if (/[\r\n]/.test(fact)) return "Write the fact as one line."
  if (fact.length > MAX_FACT) return `The fact is longer than ${MAX_FACT} characters. Shorten it to one sentence.`
  if (SECRET.test(fact)) return "This looks like a secret or credential. Secrets must not be saved to memory."
}

function schema(properties: Record<string, object>) {
  return {
    type: "object" as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bytes = (text: string) => Buffer.byteLength(text, "utf8")

// The model provider never needs the user's account name, only where to look.
function shorten(file: string) {
  const home = os.homedir()
  return home && file.toLowerCase().startsWith(home.toLowerCase()) ? path.join("~", file.slice(home.length)) : file
}

async function read(file: string): Promise<Memory> {
  const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return text.split(/\r?\n/).reduce<Memory & { section: string }>(
    (memory, line) => {
      if (line.startsWith("## ")) return { ...memory, section: line.trim() }
      const fact = line.startsWith("- ") ? line.slice(2).trim() : ""
      if (!fact) return memory
      if (memory.section === ARCHIVE) return { ...memory, archived: [...memory.archived, fact] }
      return { ...memory, facts: [...memory.facts, fact] }
    },
    { facts: [], archived: [], section: HEADING },
  )
}

async function write(file: string, memory: Memory) {
  const lines = (items: string[]) => items.map((item) => `- ${item}`).join("\n")
  const text = [
    "# Project memory",
    "",
    HEADING,
    "",
    ...(memory.facts.length ? [lines(memory.facts)] : []),
    ...(memory.archived.length ? ["", ARCHIVE, "", lines(memory.archived)] : []),
    "",
  ].join("\n")
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Replace the whole file at once so a crash never leaves half a memory behind.
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

// Matches the project ID BharatCode records in the git common directory, so every
// worktree and clone of a repository shares one memory.
async function project(cwd: string) {
  const common = await gitCommonDirectory(path.resolve(cwd))
  const id = common ? (await fs.readFile(path.join(common, "opencode"), "utf8").catch(() => "")).trim() : ""
  if (/^[A-Za-z0-9_-]{1,128}$/.test(id) && id !== "global") return id
  const directory = common ? path.dirname(common) : path.resolve(cwd)
  const key = process.platform === "win32" ? directory.toLowerCase() : directory
  return `dir-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`
}

async function gitCommonDirectory(directory: string): Promise<string | undefined> {
  const git = path.join(directory, ".git")
  const stat = await fs.stat(git).catch(() => undefined)
  if (stat?.isDirectory()) return git
  if (stat?.isFile()) {
    const target = (await fs.readFile(git, "utf8")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!target) return
    const worktree = path.resolve(directory, target)
    const common = await fs.readFile(path.join(worktree, "commondir"), "utf8").catch(() => "")
    return common.trim() ? path.resolve(worktree, common.trim()) : worktree
  }
  const parent = path.dirname(directory)
  if (parent === directory) return
  return gitCommonDirectory(parent)
}

export * as BharatCodeMemory from "./memory"
