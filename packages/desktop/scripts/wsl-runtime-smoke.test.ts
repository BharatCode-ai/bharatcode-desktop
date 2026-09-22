import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pkg from "../package.json"
import {
  decodeWslDesktopOutput,
  encodeWslDesktopRecord,
  readWslDesktopLines,
} from "../../opencode/src/server/wsl-desktop-transport"

// Explicit compiled-runtime acceptance, not part of the source-only unit suite.
// Run from packages/desktop after an exact clean --wsl-candidate CLI build.
for (const termination of ["stop", "eof"] as const) {
  test(`compiled WSL runtime verifies identity, authenticates and exits on ${termination}`, async () => {
    const expectedSource = process.env.BHARATCODE_SOURCE_SHA
    expect(expectedSource).toMatch(/^[0-9a-f]{40}$/)
    const executable = resolve("../opencode/dist/bharatcode-linux-x64/bin/bharatcode")
    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
      .digest("hex")
    const home = await mkdtemp(join(tmpdir(), "bharatcode-wsl-smoke-"))
    const port = await allocatePort()
    const password = "synthetic-stdio-only-password"
    const child = Bun.spawn(
      [executable, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--desktop-sidecar-stdio"],
      {
        cwd: home,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          USERPROFILE: home,
          OPENCODE_TEST_HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          XDG_STATE_HOME: join(home, "state"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const errors = new Response(child.stderr).text()
    const lines = readWslDesktopLines(child.stdout)[Symbol.asyncIterator]()
    const next = async () => {
      const line = await bounded(lines.next())
      expect(line.done).toBe(false)
      return decodeWslDesktopOutput(line.value!)
    }
    try {
      child.stdin.write(
        encodeWslDesktopRecord({
          type: "start",
          hostname: "127.0.0.1",
          port,
          started_at_ms: Date.now(),
          username: "bharatcode",
          password,
        }),
      )
      await child.stdin.flush()
      expect(await next()).toEqual({
        type: "identity",
        source_sha: expectedSource,
        version: pkg.version,
        executable_sha256: digest,
        uid: process.getuid!(),
      })
      expect(await next()).toEqual({ type: "ready" })
      const url = `http://127.0.0.1:${port}`
      const auth = { authorization: `Basic ${btoa(`bharatcode:${password}`)}` }
      expect((await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(5_000) })).status).toBe(401)
      expect((await fetch(`${url}/global/health`, { headers: auth, signal: AbortSignal.timeout(5_000) })).status).toBe(
        200,
      )
      const account = await fetch(`${url}/account/status`, { headers: auth, signal: AbortSignal.timeout(5_000) })
      expect(account.status).toBe(200)
      expect((await account.json()).state).toBe("signed-out")
      if (termination === "stop") {
        child.stdin.write(encodeWslDesktopRecord({ type: "stop" }))
        await child.stdin.flush()
      } else child.stdin.end()
      expect(await next()).toEqual({ type: "stopped" })
      expect(await bounded(child.exited)).toBe(0)
      expect((await bounded(lines.next())).done).toBe(true)
      expect(await errors).not.toContain(password)
      await expect(fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow()
    } finally {
      child.stdin.end()
      child.kill()
      await bounded(child.exited)
      await rm(home, { recursive: true, force: true })
    }
  }, 45_000)
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Compiled WSL lifecycle timed out")), 15_000)
    }),
  ]).finally(() => clearTimeout(timer))
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const socket = createServer()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (!address || typeof address === "string") return reject(new Error("No TCP port"))
      socket.close(() => resolve(address.port))
    })
  })
}
