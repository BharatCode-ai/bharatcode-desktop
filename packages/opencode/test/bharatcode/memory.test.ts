import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BharatCodeMemory } from "../../src/bharatcode/memory"

async function temp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "bc-memory-"))
}

test("first save creates the file, later saves append, duplicates are skipped", async () => {
  const root = await temp()
  try {
    const file = path.join(root, "memory", "project", "MEMORY.md")
    expect(await BharatCodeMemory.facts(file)).toEqual([])
    expect(await BharatCodeMemory.save(file, "  This project uses Bun, not npm.  ")).toEqual({
      saved: true,
      error: false,
      message: "Saved.",
    })
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

test("instructions keep the newest facts within the per-chat budget and put rules first", () => {
  const facts = Array.from({ length: 100 }, (_, index) => `Fact number ${index} ${"x".repeat(60)}`)
  const text = BharatCodeMemory.instructions({ facts, file: "/memory/MEMORY.md" })
  expect(text).toContain("AGENTS.md, the user's instructions and the actual code always take priority")
  expect(text).toContain("- Fact number 99 ")
  expect(text).not.toContain("- Fact number 0 ")
  expect(text).toMatch(/\d+ older facts are not shown/)
  expect(text.length).toBeLessThan(BharatCodeMemory.BUDGET + 1_000)
  expect(BharatCodeMemory.instructions({ facts: [], file: "/m" })).toContain("No facts saved yet.")
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
