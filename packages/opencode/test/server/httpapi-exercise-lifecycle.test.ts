import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("scenario scopes close before isolated database reset on success and failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "httpapi-lifecycle-"))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "httpapi-exercise/lifecycle-probe.ts")], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_HTTPAPI_EXERCISE_GLOBAL: path.join(root, "exercise"),
      OPENCODE_HTTPAPI_EXERCISE_DB: path.join(root, "exercise.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 45_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
    expect(stdout).toContain("scenario lifecycle passed")
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
