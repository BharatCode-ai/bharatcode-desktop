import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pkg from "../../package.json"

const packageRoot = resolve(import.meta.dir, "../..")
const roots: string[] = []

afterAll(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

async function run(argv: string[], cwd: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(argv, {
    cwd,
    env: {
      ...Bun.env,
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${exitCode}):\n${stderr}`)
  return { stdout, stderr }
}

async function pack(cwd: string, destination: string) {
  const before = new Set(readdirSync(destination))
  await run(["bun", "pm", "pack", "--destination", destination], cwd)
  const filename = readdirSync(destination).find((item) => !before.has(item) && item.endsWith(".tgz"))
  if (!filename) throw new Error(`bun pm pack produced no tarball in ${destination}`)
  return join(destination, filename)
}

describe("lean BharatCode npm package", () => {
  test("publishes one direct BharatCode command with no OpenCode launcher", async () => {
    expect(pkg.name).toBe("bharatcode")
    expect(pkg.bin).toEqual({ bharatcode: "./bin/bharatcode.mjs" })
    expect(existsSync(join(packageRoot, "bin", "opencode"))).toBe(false)
    const launcher = await Bun.file(join(packageRoot, "bin", "bharatcode.mjs")).text()
    expect(launcher).not.toMatch(/require\(["']opencode|node_modules\/opencode|bin\/opencode/)
  })

  test("installs the locally packed complete runtime without an OpenCode package or binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "bharatcode-lean-package-"))
    roots.push(root)
    await run(["bun", "run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"], packageRoot, {
      OPENCODE_VERSION: "0.0.0-lean-test",
    })

    const platformDirectory = readdirSync(join(packageRoot, "dist"))
      .filter((item) =>
        item.startsWith(`bharatcode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`),
      )
      .map((item) => join(packageRoot, "dist", item))
      .find((item) => existsSync(join(item, "bin", process.platform === "win32" ? "bharatcode.exe" : "bharatcode")))
    if (!platformDirectory) throw new Error("build produced no host BharatCode platform package")
    const platformManifest = await Bun.file(join(platformDirectory, "package.json")).json()
    expect(platformManifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/BharatCode-ai/bharatcode-cli.git",
    })
    const platformTarball = await pack(platformDirectory, root)

    const meta = join(root, "meta")
    mkdirSync(join(meta, "bin"), { recursive: true })
    mkdirSync(join(meta, "script"), { recursive: true })
    cpSync(join(packageRoot, "bin", "bharatcode.mjs"), join(meta, "bin", "bharatcode.mjs"))
    cpSync(join(packageRoot, "script", "distribution.mjs"), join(meta, "script", "distribution.mjs"), {
      recursive: true,
    })
    writeFileSync(
      join(meta, "package.json"),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        type: "module",
        bin: pkg.bin,
        files: ["bin", "script/distribution.mjs"],
      }),
    )
    chmodSync(join(meta, "bin", "bharatcode.mjs"), 0o755)
    const metaTarball = await pack(meta, root)

    const consumer = join(root, "consumer")
    mkdirSync(consumer)
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true }))
    await run(["bun", "add", "--ignore-scripts", platformTarball, metaTarball], consumer)
    const executable = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "bharatcode.exe" : "bharatcode",
    )
    const help = await run([executable, "--help"], consumer)
    const noninteractive = await run([executable, "run", "--help"], consumer)
    const tui = await run([executable, "--help"], consumer)

    expect(help.stdout).toContain("bharatcode")
    expect(`${help.stdout}${help.stderr}`).not.toContain("opencode ")
    expect(noninteractive.stdout).toContain("bharatcode run")
    expect(tui.stdout).toContain("bharatcode")
    expect(readdirSync(join(consumer, "node_modules")).some((item) => item === "opencode")).toBe(false)
    expect(existsSync(join(consumer, "node_modules", ".bin", "opencode"))).toBe(false)
  }, 120_000)
})
