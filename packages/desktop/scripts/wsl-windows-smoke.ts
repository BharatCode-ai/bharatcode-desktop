// Bundle with Bun target=node and run with Windows Node. This starts only a
// test-owned Linux process/home; it never installs an app or registers a protocol.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { posix, win32 } from "node:path"
import { connectWslChild } from "../src/main/wsl/transport"
import { wslArgs } from "../src/main/wsl/args"
import { parseWslRuntimeManifest } from "../src/main/wsl/artifact"
import { provisionWslRuntime, resolveWslIdentity } from "../src/main/wsl/provision"

assert.equal(process.platform, "win32", "This smoke requires native Windows Node")
const [distro, executable, manifestPath, binaryWindowsPath, sourceSha] = process.argv.slice(2)
assert.match(distro, /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u)
assert.equal(posix.isAbsolute(executable), true)
assert.equal(posix.normalize(executable), executable)
const manifest = parseWslRuntimeManifest(JSON.parse(await readFile(manifestPath, "utf8")))
assert.equal(manifest.source_sha, sourceSha)
assert.equal(
  createHash("sha256")
    .update(await readFile(binaryWindowsPath))
    .digest("hex"),
  manifest.sha256,
)
const hostEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined && ["SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"].includes(key.toUpperCase()),
  ),
)
const run = (args: string[], user?: string) =>
  execFileSync("wsl.exe", wslArgs(args, distro, user), {
    env: hostEnv,
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
  }).trimEnd()
const uid = Number(run(["/usr/bin/id", "-u"]))
assert.equal(Number.isSafeInteger(uid) && uid > 0, true)
// Exercise the production argv builder across the real native boundary, not a
// separately corrected test launcher. These values must never become shell code.
const literal = String.raw`C:\Users\Fixture Name\runtime & $HOME; 'quoted'.exe`
assert.equal(run(["/usr/bin/printf", "%s", literal]), literal)
assert.equal(run(["sh", "-c", "printf explicit-shell"]), "explicit-shell")
assert.ok(process.env.TEMP)
assert.equal(
  win32
    .normalize(run(["/usr/bin/wslpath", "-w", "--", run(["/usr/bin/wslpath", "-u", "--", process.env.TEMP])]))
    .toLowerCase(),
  win32.normalize(process.env.TEMP).toLowerCase(),
)
const home = run(["/usr/bin/mktemp", "-d", "/tmp/bharatcode-wsl-windows-smoke.XXXXXXXX"])
assert.match(home, /^\/tmp\/bharatcode-wsl-windows-smoke\.[A-Za-z0-9]{8}$/)
const execute = async (_distro: string, args: string[], user?: string) => run(args, user)
const user = await resolveWslIdentity(execute, distro)
const fixture = {
  execute,
  distro,
  identity: { ...user, home },
  channel: manifest.channel,
  sourcePath: executable,
  manifest,
}
let installed: string
try {
  installed = await provisionWslRuntime({ ...fixture, install: true })
  assert.equal(await provisionWslRuntime({ ...fixture, install: false }), installed)
} catch (error) {
  run(["/usr/bin/rm", "-rf", "--", home])
  throw error
}
let sessionID: string | undefined
try {
  const project = `${home}/project with spaces`
  run(["/usr/bin/mkdir", project])
  run(["/usr/bin/git", "init", "--quiet", project])
  for (const phase of ["create", "reopen"]) {
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer()
      socket.once("error", reject)
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        assert.equal(typeof address, "object")
        assert.ok(address && typeof address !== "string")
        socket.close(() => resolve(address.port))
      })
    })
    const child = spawn(
      "wsl.exe",
      wslArgs(
        [
          "/usr/bin/env",
          "-i",
          `HOME=${home}`,
          `USERPROFILE=${home}`,
          `OPENCODE_TEST_HOME=${home}`,
          "PATH=/usr/bin:/bin",
          `XDG_DATA_HOME=${home}/data`,
          `XDG_STATE_HOME=${home}/state`,
          `XDG_CONFIG_HOME=${home}/config`,
          `XDG_CACHE_HOME=${home}/cache`,
          "OPENCODE_DISABLE_MODELS_FETCH=true",
          "OPENCODE_PURE=1",
          "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
          installed,
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
          "--desktop-sidecar-stdio",
        ],
        distro,
        undefined,
        project,
      ),
      { env: hostEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    )
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    try {
      const listener = await connectWslChild(child, {
        port,
        password: "synthetic-windows-wsl-smoke",
        identity: {
          type: "identity",
          source_sha: sourceSha,
          version: manifest.version,
          channel: manifest.channel,
          executable_sha256: manifest.sha256,
          uid,
        },
      })
      const request = async (route: string, init?: RequestInit) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          ...init,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Basic ${Buffer.from("bharatcode:synthetic-windows-wsl-smoke").toString("base64")}`,
            "x-opencode-directory": encodeURIComponent(project),
            "content-type": "application/json",
          },
        })
        assert.equal(response.status, 200, `${phase}:${route}:HTTP status`)
        return response.json()
      }
      assert.equal((await request("/account/status")).state, "signed-out")
      const paths = await request("/path")
      assert.equal(paths.directory, project)
      assert.equal(paths.home, home)
      if (phase === "create") {
        const session = await request("/session", {
          method: "POST",
          body: JSON.stringify({ title: "WSL persisted fixture" }),
        })
        assert.equal(typeof session.id, "string")
        assert.equal(session.directory, project)
        sessionID = session.id
      } else {
        assert.ok(sessionID)
        const session = await request(`/session/${sessionID}`)
        assert.equal(session.title, "WSL persisted fixture")
        assert.equal(session.directory, project)
        await request(`/session/${sessionID}`, { method: "DELETE" })
      }
      const stopped = listener.stop()
      assert.equal(listener.stop(), stopped)
      await stopped
      await closed
      assert.equal(child.exitCode, 0)
      await assert.rejects(fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(2000) }))
    } finally {
      child.stdin.end()
      child.kill()
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("WSL cleanup timed out")), 5000).unref()),
      ])
    }
  }
  console.log("WINDOWS_WSL_PROVISION_TRANSPORT_PERSISTENCE_PASS")
} finally {
  // Exact directory created above, never a user profile or an arbitrary path.
  assert.equal(run(["/usr/bin/realpath", "--", home]), home)
  run(["/usr/bin/rm", "-rf", "--", home])
}
