import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

for (const owner of ["global", "migration"] as const) {
  test.skipIf(process.platform !== "win32" || !process.env.BHARATCODE_TEST_FIRST_USE_EXE)(
    `normal inherited fresh profile: ${owner} creates private storage before credentials, then restart/rotate/logout`,
    async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bc-first-use-")))
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
        }
        // OS-owned profile parents only; no app directory, ACL preparation or credential file fixture.
        await mkdir(env.APPDATA, { recursive: true })
        await mkdir(env.LOCALAPPDATA, { recursive: true })
        for (const [action, generation] of [
          [owner, 1],
          ["read", 1],
          ["rotate", 2],
          ["read", 2],
          ["logout", 0],
          ["read", 0],
        ] as const) {
          const result = spawnSync(process.env.BHARATCODE_TEST_FIRST_USE_EXE!, [], {
            cwd: root,
            env,
            input: JSON.stringify({ root, action }),
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
          })
          if (result.status !== 0) throw new Error(`Synthetic ${owner}/${action} failed: ${result.stderr}`)
          expect(result.status).toBe(0)
          expect(JSON.parse(result.stdout)).toEqual({ generation })
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    120_000,
  )
}
