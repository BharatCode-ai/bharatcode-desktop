import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Opt-in: exercise the packaged native CLI, never a user's actual home.
const executable = process.env.BHARATCODE_TEST_RECOVERY_EXE
const native = test.skipIf(process.platform !== "win32" || !executable)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "bc-installed-recovery-"))
  roots.push(home)
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    TEMP: home,
    TMP: home,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_TEST_HOME: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    BHARATCODE_CHANNEL: "beta",
  }
  const run = (args: string[], success = true) => {
    if (!executable || !path.isAbsolute(executable)) throw new Error("An absolute packaged CLI is required")
    const result = spawnSync(executable, args, { cwd: home, env, encoding: "utf8", windowsHide: true, timeout: 30_000 })
    expect(result.error).toBeUndefined()
    if (!success) {
      expect(result.status).not.toBe(0)
      return
    }
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout)
  }
  const seed = async (relative: string, text: string) => {
    const file = path.join(home, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
    return file
  }
  return { home, run, seed }
}

native(
  "packaged CLI selects a valid source with malformed peers and preserves the source",
  async () => {
    const f = await fixture()
    const good = await f.seed(".bharatcode/settings.json", '{"theme":"dark"}')
    await f.seed(".config/opencode/opencode.json", "INVALID_SYNTHETIC_JSON")
    const before = f.run(["recovery", "status", "--json"])
    expect(before.state).toBe("choose-source")
    expect(before.sources).toHaveLength(1)
    const choice = before.sources[0]
    expect(
      f.run([
        "recovery",
        "choose-source",
        "--id",
        choice.id,
        "--content-fingerprint",
        choice.contentFingerprint,
        "--json",
      ]),
    ).toEqual({ state: "ready" })
    expect(f.run(["recovery", "status", "--json"])).toEqual({ state: "ready" })
    expect(await readFile(good, "utf8")).toBe('{"theme":"dark"}')
  },
  90_000,
)

native(
  "packaged CLI rejects a selected source that became malformed without taking a valid peer",
  async () => {
    const f = await fixture()
    const one = await f.seed(".bharatcode/settings.json", '{"theme":"dark"}')
    const two = await f.seed(".config/opencode/opencode.json", '{"theme":"light"}')
    const status = f.run(["recovery", "status", "--json"])
    expect(status.sources).toHaveLength(2)
    const choice = status.sources.find((item: { label: string }) => item.label.includes("bharatcode-desktop"))
    expect(choice).toBeDefined()
    await writeFile(one, "INVALID_SYNTHETIC_JSON")
    f.run(
      ["recovery", "choose-source", "--id", choice.id, "--content-fingerprint", choice.contentFingerprint, "--json"],
      false,
    )
    expect(await readFile(two, "utf8")).toBe('{"theme":"light"}')
    expect((await readdir(f.home, { recursive: true })).some((file) => file.endsWith("lean-migration-v1.json"))).toBe(
      false,
    )
  },
  90_000,
)

native(
  "packaged CLI Start Fresh and interrupted starting-fresh Retry both reach ready",
  async () => {
    const f = await fixture()
    expect(f.run(["recovery", "status", "--json"])).toEqual({ state: "start-fresh", reason: "no-source" })
    expect(f.run(["recovery", "start-fresh", "--confirm", "--json"])).toEqual({ state: "ready" })
    const journals = (await readdir(f.home, { recursive: true })).filter((file) =>
      file.endsWith("lean-migration-v1.json"),
    )
    expect(journals).toHaveLength(1)
    const file = path.join(f.home, journals[0]!)
    const journal = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...journal, phase: "starting-fresh" }))
    expect(f.run(["recovery", "status", "--json"])).toEqual({ state: "retry", operationID: journal.operationID })
    expect(f.run(["recovery", "retry", "--operation-id", journal.operationID, "--json"])).toEqual({ state: "ready" })
    expect(f.run(["recovery", "status", "--json"])).toEqual({ state: "ready" })
  },
  120_000,
)
