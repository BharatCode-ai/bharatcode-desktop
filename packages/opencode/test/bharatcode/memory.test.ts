import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BharatCodeMemory } from "../../src/bharatcode/memory"

async function temp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "bc-memory-"))
}

const listing = (facts: string[]) => BharatCodeMemory.tools(facts)[0].description

test("first save creates the file, later saves append, duplicates are skipped", async () => {
  const root = await temp()
  try {
    const file = path.join(root, "memory", "project", "MEMORY.md")
    expect(await BharatCodeMemory.facts(file)).toEqual([])
    const first = await BharatCodeMemory.save(file, "  This project uses Bun, not npm.  ")
    expect(first.saved).toBe(true)
    expect(first.message).toContain("[1] This project uses Bun, not npm.")
    await BharatCodeMemory.save(file, "Tests live in packages/x/test.")
    expect((await BharatCodeMemory.save(file, "this project uses bun, not npm.")).message).toBe(
      "This fact is already saved.",
    )
    expect(await BharatCodeMemory.facts(file)).toEqual([
      "This project uses Bun, not npm.",
      "Tests live in packages/x/test.",
    ])
    expect(await fs.readFile(file, "utf8")).toBe(
      "# Project memory\n\n## Remembered facts\n\n- This project uses Bun, not npm.\n- Tests live in packages/x/test.\n",
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("update and forget correct facts and keep the old text archived, out of the prompt", async () => {
  const root = await temp()
  try {
    const file = path.join(root, "MEMORY.md")
    await BharatCodeMemory.save(file, "Use npm to install.")
    await BharatCodeMemory.save(file, "Tests live in test/.")
    await BharatCodeMemory.save(file, "Deploys go through staging.")

    const updated = await BharatCodeMemory.update(file, 1, "Use Bun to install, never npm.")
    expect(updated.saved).toBe(true)
    expect(await BharatCodeMemory.facts(file)).toEqual([
      "Use Bun to install, never npm.",
      "Tests live in test/.",
      "Deploys go through staging.",
    ])

    const forgotten = await BharatCodeMemory.forget(file, 2)
    expect(forgotten.saved).toBe(true)
    expect(forgotten.message).toContain("[2] Deploys go through staging.")
    expect(await BharatCodeMemory.facts(file)).toEqual([
      "Use Bun to install, never npm.",
      "Deploys go through staging.",
    ])

    const text = await fs.readFile(file, "utf8")
    expect(text).toMatch(/## Archived facts\n\n- Use npm to install\. \(replaced \d{4}-\d{2}-\d{2}\)/)
    expect(text).toMatch(/- Tests live in test\/\. \(forgotten \d{4}-\d{2}-\d{2}\)/)
    expect(listing(await BharatCodeMemory.facts(file))).not.toContain("npm to install.")

    for (const result of [
      await BharatCodeMemory.forget(file, 9),
      await BharatCodeMemory.update(file, 0, "x"),
      await BharatCodeMemory.update(file, 1.5, "x"),
    ])
      expect(result).toMatchObject({ saved: false, error: true })
    expect((await BharatCodeMemory.update(file, 2, "use bun to install, never npm.")).message).toBe(
      "This fact is already saved.",
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("empty, multi-line, too long and secret-looking facts are rejected without writing", async () => {
  const root = await temp()
  try {
    const file = path.join(root, "MEMORY.md")
    for (const fact of [
      "   ",
      "first line\nsecond line",
      "x".repeat(BharatCodeMemory.MAX_FACT + 1),
      "The deploy key is sk-abcdefghijklmnopqrstuvwxyz123456",
      "Use ghp_abcdefghijklmnopqrstuvwxyz0123 for the API",
    ]) {
      const result = await BharatCodeMemory.save(file, fact)
      expect(result.saved).toBe(false)
      expect(result.error).toBe(true)
    }
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the fact list keeps the newest facts within a byte budget, with real numbers", () => {
  const facts = Array.from({ length: 100 }, (_, index) => `Fact number ${index} ${"x".repeat(60)}`)
  const text = listing(facts)
  expect(text).toContain("[100] Fact number 99 ")
  expect(text).not.toContain("[1] Fact number 0 ")
  expect(text).toMatch(/\d+ older facts are not listed/)
  expect(listing([])).toContain("No facts saved yet.")

  // Devanagari takes three UTF-8 bytes per character, so far fewer Hindi facts fit.
  const hindi = Array.from({ length: 100 }, (_, index) => `${index} ${"परियोजना बन का उपयोग करती है ".repeat(3)}`)
  const shown = listing(hindi)
    .split("\n")
    .filter((line) => line.startsWith("["))
  expect(Buffer.byteLength(shown.join("\n"), "utf8")).toBeLessThanOrEqual(BharatCodeMemory.BUDGET)
  expect(shown.length).toBeLessThan(hindi.length)
})

test("instructions point at the tool list, put rules first, and hide the user's home folder", () => {
  const file = path.join(os.homedir(), "AppData", "Local", "BharatCode", "Data", "memory", "abc", "MEMORY.md")
  const text = BharatCodeMemory.instructions(file)
  expect(text).toContain("AGENTS.md, the user's instructions and the actual code always take priority")
  expect(text).toContain("save_memory tool description")
  expect(text).toContain(path.join("~", "AppData", "Local", "BharatCode", "Data", "memory", "abc", "MEMORY.md"))
  expect(text).not.toContain(os.homedir())
  expect(BharatCodeMemory.tools([]).map((tool) => tool.name)).toEqual(["save_memory", "update_memory", "forget_memory"])
})

test("memory is keyed by the recorded project ID, shared by worktrees, and separate per folder otherwise", async () => {
  const root = await temp()
  try {
    const repo = path.join(root, "repo")
    await fs.mkdir(path.join(repo, ".git", "worktrees", "feature"), { recursive: true })
    await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true })
    await fs.writeFile(path.join(repo, ".git", "opencode"), "abc123\n")
    const worktree = path.join(root, "feature")
    await fs.mkdir(worktree)
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "feature")}\n`)
    await fs.writeFile(path.join(repo, ".git", "worktrees", "feature", "commondir"), "../..\n")

    const memory = path.join(root, "memory")
    const expected = path.join(memory, "abc123", "MEMORY.md")
    expect(await BharatCodeMemory.locate(memory, repo)).toBe(expected)
    expect(await BharatCodeMemory.locate(memory, path.join(repo, "packages", "app"))).toBe(expected)
    expect(await BharatCodeMemory.locate(memory, worktree)).toBe(expected)

    const a = path.join(root, "plain-a")
    const b = path.join(root, "plain-b")
    await fs.mkdir(a)
    await fs.mkdir(b)
    const first = await BharatCodeMemory.locate(memory, a)
    expect(path.basename(path.dirname(first))).toMatch(/^dir-[0-9a-f]{16}$/)
    expect(await BharatCodeMemory.locate(memory, b)).not.toBe(first)
    expect(await BharatCodeMemory.locate(memory, a)).toBe(first)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
