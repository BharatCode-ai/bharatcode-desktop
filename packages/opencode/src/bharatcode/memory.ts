// Project memory: one private Markdown file per project, outside the repo. The single
// save_memory tool follows Qwen Code's memory tool (Apache-2.0, QwenLM/qwen-code); the
// per-turn size budget follows Engram (MIT, kenz1117/dsh-engram).
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

// About 1,000 tokens of saved facts are loaded into each chat.
export const BUDGET = 4_000
export const MAX_FACT = 500
const HEADING = "## Remembered facts"
const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY|\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./

export const TOOL = {
  name: "save_memory",
  description: [
    "Saves one stable fact about this project so it is remembered in future chats.",
    "Use it when the user asks you to remember something, or when you learn a durable project convention, such as how to build or test, which tools or package manager to use, where things live, or a preference the user stated.",
    "Do not save secrets, credentials, personal data, temporary task state, conversation history, or anything already written in AGENTS.md.",
    "Write one short, standalone sentence.",
  ].join(" "),
  inputSchema: {
    type: "object" as const,
    properties: {
      fact: {
        type: "string",
        description: `One short standalone sentence, at most ${MAX_FACT} characters, for example "This project uses Bun, not npm."`,
      },
    },
    required: ["fact"],
    additionalProperties: false,
  },
}

export async function locate(root: string, cwd: string) {
  return path.join(root, await project(cwd), "MEMORY.md")
}

export async function facts(file: string) {
  const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

export function instructions(input: { facts: string[]; file: string }) {
  // Keep the newest facts when the file outgrows the per-chat budget.
  const loaded = input.facts.reduceRight<string[]>(
    (kept, fact) => (kept.join("\n").length + fact.length + 3 > BUDGET ? kept : [fact, ...kept]),
    [],
  )
  const skipped = input.facts.length - loaded.length
  return [
    "Project memory: facts saved in earlier chats about this project.",
    "They are hints and may be out of date. AGENTS.md, the user's instructions and the actual code always take priority over a remembered fact.",
    loaded.length ? loaded.map((fact) => `- ${fact}`).join("\n") : "No facts saved yet.",
    ...(skipped ? [`${skipped} older facts are not shown here to save space.`] : []),
    `Call save_memory to remember a new stable fact. The user can view or edit the memory file at ${input.file}.`,
  ].join("\n\n")
}

export async function save(file: string, input: string) {
  const fact = input.trim()
  const problem = check(fact)
  if (problem) return { saved: false, error: true, message: problem }
  const existing = await facts(file)
  if (existing.some((item) => item.toLowerCase() === fact.toLowerCase()))
    return { saved: false, error: false, message: "This fact is already saved." }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const prefix = existing.length ? "" : `# Project memory\n\n${HEADING}\n\n`
  await fs.appendFile(file, `${prefix}- ${fact}\n`, { mode: 0o600 })
  const size = [...existing, fact].join("\n").length
  return {
    saved: true,
    error: false,
    message:
      size > BUDGET
        ? `Saved. The memory file is now larger than what loads into each chat, so only the newest facts are loaded. Ask the user to tidy ${file}.`
        : "Saved.",
  }
}

function check(fact: string) {
  if (!fact) return "The fact is empty."
  if (/[\r\n]/.test(fact)) return "Write the fact as one line."
  if (fact.length > MAX_FACT) return `The fact is longer than ${MAX_FACT} characters. Shorten it to one sentence.`
  if (SECRET.test(fact)) return "This looks like a secret or credential. Secrets must not be saved to memory."
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
