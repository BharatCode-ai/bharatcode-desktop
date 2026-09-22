// Bundle with Bun target=node and run with Windows Node. This starts only a
// test-owned Linux process/home; it never installs an app or registers a protocol.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { posix } from "node:path"
import { connectWslChild } from "../src/main/wsl/transport"
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
  execFileSync("wsl.exe", ["--distribution", distro, ...(user ? ["--user", user] : []), "--exec", ...args], {
    env: hostEnv,
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
  }).trimEnd()
const uid = Number(run(["/usr/bin/id", "-u"]))
assert.equal(Number.isSafeInteger(uid) && uid > 0, true)
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
  [
    "--distribution",
    distro,
    "--cd",
    home,
    "--exec",
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
    installed,
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
    "--desktop-sidecar-stdio",
  ],
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
  await listener.stop()
  await closed
  assert.equal(child.exitCode, 0)
  await assert.rejects(fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(2000) }))
  console.log("WINDOWS_WSL_PROVISION_TRANSPORT_PASS")
} finally {
  child.stdin.end()
  child.kill()
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("WSL cleanup timed out")), 5000).unref()),
  ])
  // Exact directory created above, never a user profile or an arbitrary path.
  run(["/usr/bin/rm", "-rf", "--", home])
}
