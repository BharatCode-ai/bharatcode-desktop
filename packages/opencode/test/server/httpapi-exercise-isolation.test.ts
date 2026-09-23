import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("authenticated route probes do not modify the invoking project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "httpapi-probe-isolation-"))
  const cwd = path.join(root, "caller")
  await mkdir(cwd)
  const config = path.join(cwd, "config.json")
  const original = '{"username":"caller-must-not-change"}\n'
  await Bun.write(config, original)
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../script/httpapi-exercise.ts"),
      "--mode",
      "auth",
      "--include",
      "config.update",
      "--fail-on-skip",
    ],
    {
      cwd,
      env: {
        ...process.env,
        OPENCODE_HTTPAPI_EXERCISE_GLOBAL: path.join(root, "exercise"),
        OPENCODE_HTTPAPI_EXERCISE_DB: path.join(root, "exercise.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timeout = setTimeout(() => child.kill(), 45_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
    expect(stdout).toContain("config.update")
    expect(await Bun.file(config).text()).toBe(original)
    expect(await Bun.file(path.join(root, "exercise", "auth-project", "config.json")).exists()).toBe(true)
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
