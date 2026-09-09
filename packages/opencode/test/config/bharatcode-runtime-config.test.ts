import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ConfigPaths } from "@/config/paths"
import { Database } from "@/storage/db"
import { Global } from "@opencode-ai/core/global"

const roots: string[] = []
const packageRoot = path.resolve(import.meta.dir, "../..")

afterAll(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("BharatCode runtime config discovery", () => {
  test("uses the canonical BharatCode database destination", () => {
    const database = Database.getChannelPath({ disableChannelDb: false })
    expect(database).toBe(Global.Path.database)
    expect(path.basename(database)).toBe("bharatcode.db")
  })

  test("discovers only branded server and TUI identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bharatcode-runtime-config-"))
    roots.push(root)
    const project = path.join(root, "project")
    const nested = path.join(project, "src")
    await mkdir(path.join(project, ".bharatcode"), { recursive: true })
    await mkdir(path.join(project, ".opencode"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await Promise.all(
      [
        "bharatcode.json",
        "bharatcode.jsonc",
        "opencode.json",
        "opencode.jsonc",
        "tui.json",
        ".bharatcode/bharatcode.json",
        ".bharatcode/tui.json",
        ".opencode/opencode.json",
      ].map((file) => writeFile(path.join(project, file), "{}")),
    )

    const [server, tui, directories] = await Effect.runPromise(
      Effect.all(
        [
          ConfigPaths.files("bharatcode", nested, project),
          ConfigPaths.files("tui", nested, project),
          ConfigPaths.directories(nested, project),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(AppFileSystem.defaultLayer)),
    )

    expect(server).toEqual([path.join(project, "bharatcode.json"), path.join(project, "bharatcode.jsonc")])
    expect(tui).toEqual([])
    expect(directories).toContain(path.join(project, ".bharatcode"))
    expect(directories).not.toContain(path.join(project, ".opencode"))
    expect(ConfigPaths.fileInDirectory(path.join(project, ".bharatcode"), "tui")).toEqual([
      path.join(project, ".bharatcode", "tui.json"),
      path.join(project, ".bharatcode", "tui.jsonc"),
    ])
    expect(
      [...server, ...tui, ...directories]
        .map((item) => path.basename(item))
        .join("\n")
        .toLowerCase(),
    ).not.toContain("opencode")
  })

  test("the shipped CLI ignores legacy config sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bharatcode-runtime-config-cli-"))
    roots.push(root)
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const global = path.join(config, "bharatcode")
    await Promise.all([
      mkdir(path.join(project, ".bharatcode"), { recursive: true }),
      mkdir(path.join(project, ".opencode"), { recursive: true }),
      mkdir(global, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(global, "bharatcode.json"), JSON.stringify({ username: "branded-global" })),
      writeFile(path.join(global, "opencode.json"), JSON.stringify({ username: "legacy-global" })),
      writeFile(path.join(project, "bharatcode.json"), JSON.stringify({ username: "branded-project" })),
      writeFile(path.join(project, "opencode.json"), JSON.stringify({ username: "legacy-project" })),
      writeFile(
        path.join(project, ".bharatcode", "bharatcode.json"),
        JSON.stringify({ username: "branded-dot", $schema: "https://opencode.ai/config.json" }),
      ),
      writeFile(path.join(project, ".opencode", "opencode.json"), JSON.stringify({ username: "legacy-dot" })),
    ])

    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", path.join(packageRoot, "src", "index.ts"), "debug", "config"],
      {
        cwd: project,
        env: {
          ...Bun.env,
          BHARATCODE_CHANNEL: "prod",
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          OPENCODE_DB: ":memory:",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stderr)
    expect(JSON.parse(stdout)).toMatchObject({ username: "branded-dot" })
    expect(stdout).not.toContain("legacy-")
    expect(stdout).not.toContain("opencode.ai/config.json")
    expect(stderr).not.toContain("opencode.ai/config.json")
  }, 30_000)
})
