import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const executable = process.env.BHARATCODE_TEST_DESKTOP_EXE
test.skipIf(process.platform !== "win32" || !executable)(
  "exact packaged Start Fresh, project sessions and restart use the valid native marker",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bc-project-packaged-")))
    try {
      const env = {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        OPENCODE_TEST_HOME: root,
        TEMP: root,
        TMP: root,
        APPDATA: path.join(root, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(root, "AppData", "Local"),
        BHARATCODE_CHANNEL: "beta",
        BHARATCODE_SERVER_USERNAME: "bharatcode",
        BHARATCODE_SERVER_PASSWORD: "synthetic-project-password",
        ELECTRON_RUN_AS_NODE: "1",
      }
      await mkdir(env.APPDATA, { recursive: true })
      await mkdir(env.LOCALAPPDATA, { recursive: true })
      const recovery = path.join(path.dirname(executable!), "resources", "bharatcode-opencode-cli.exe")
      const prepared = spawnSync(recovery, ["recovery", "start-fresh", "--confirm", "--json"], {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      })
      expect(prepared.status).toBe(0)
      expect(JSON.parse(prepared.stdout)).toEqual({ state: "ready" })
      const sidecar = path.join(path.dirname(executable!), "resources", "app.asar", "out", "main", "sidecar.js")
      const database = path.join(env.LOCALAPPDATA, "bharatcode-beta", "Data", "bharatcode.db")
      const run = async () => {
        const before = await stat(database).then(
          (value) => value.size,
          () => null,
        )
        const result = spawnSync(
          executable!,
          [path.resolve(import.meta.dirname, "../fixture/packaged-project-bootstrap.mjs"), root, sidecar],
          { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 90_000 },
        )
        if (result.status !== 0) {
          const logRoot = path.join(env.LOCALAPPDATA, "bharatcode-beta", "Log")
          const logs = await Promise.all(
            (await readdir(logRoot))
              .filter((name) => name.endsWith(".log"))
              .map((name) => readFile(path.join(logRoot, name), "utf8")),
          )
          const after = await stat(database).then(
            (value) => value.size,
            () => null,
          )
          throw new Error(
            `Packaged isolated project failed (exit ${result.status}); ${result.stderr.match(/PACKAGED_PROJECT_[^\r\n]*/g)?.join("; ") ?? "no fixture result"}; databaseRecovery=${logs.some((log) => log.includes("DatabaseRecoveryRequired"))}; mainBytes=${before}->${after}`,
          )
        }
        expect(result.stdout).toContain("PACKAGED_PROJECT_PASS")
      }
      await run()
      const marker = path.join(env.LOCALAPPDATA, "bharatcode-beta", "Data", ".schema-version")
      const before = await readFile(marker)
      await run()
      expect(await readFile(marker)).toEqual(before)
    } finally {
      expect(path.basename(root)).toStartWith("bc-project-packaged-")
      expect(path.dirname(root)).toBe(await realpath(os.tmpdir()))
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000,
)
