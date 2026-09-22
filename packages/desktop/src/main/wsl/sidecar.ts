import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { checkHealth } from "../server"
import { resolveWslOpencode, shellEscape, wslArgs } from "./runtime"
import { pollWslHealth } from "./startup"
import { nativeT } from "../native-translations"

export type WslSidecar = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}

export async function spawnWslSidecar(distro: string, opts: { healthTimeoutMs?: number } = {}): Promise<WslSidecar> {
  const opencode = await resolveWslOpencode(distro)
  if (!opencode) throw new Error(nativeT("desktop.wsl.error.opencodeNotInstalled", { distro }))

  const port = await allocatePort()
  const password = randomUUID()
  const username = "opencode"
  const script = [
    "set -euo pipefail",
    'cd "$HOME" || cd /',
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    "export WSLENV=",
    "export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
    "export OPENCODE_CLIENT=desktop",
    `export OPENCODE_SERVER_USERNAME=${shellEscape(username)}`,
    `export OPENCODE_SERVER_PASSWORD=${shellEscape(password)}`,
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `exec ${shellEscape(opencode)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 127.0.0.1 --port ${port}`,
  ].join("\n")
  const child = spawn("wsl", wslArgs(["bash", "-se"], distro), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdin.end(script)

  // Drain output without forwarding arbitrary child output to renderer errors
  // or the main log. Startup exposes only fixed lifecycle outcomes.
  child.stdout.resume()
  child.stderr.resume()

  const exit = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(startupFailure(code, signal))))
  })
  const url = `http://127.0.0.1:${port}`
  const startup = new AbortController()
  const health = pollWslHealth(() => checkHealth(url, password), startup.signal)
  const timeoutMs = opts.healthTimeoutMs ?? 30_000
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(nativeT("desktop.wsl.error.healthTimeout", { distro, timeout: timeoutMs }))),
        timeoutMs,
      )),
  )

  await Promise.race([health, exit, timedOut])
    .catch((error) => {
      child.kill()
      throw error
    })
    .finally(() => {
      clearTimeout(timeout)
      startup.abort()
    })
  return {
    listener: {
      stop: () => child.kill(),
      onExit: (cb) => child.once("exit", cb),
    },
    url,
    username,
    password,
  }
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error(nativeT("desktop.wsl.error.failedPort")))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null) {
  return nativeT("desktop.wsl.error.serverExitedBeforeHealthy", {
    code: code ?? "null",
    signal: signal ?? "null",
    output: "",
  })
}
