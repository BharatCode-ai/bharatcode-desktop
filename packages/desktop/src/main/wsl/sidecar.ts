import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { bundledWslRuntime } from "./bundle"
import { connectWslChild } from "./transport"
import { wslArgs } from "./runtime"
import { nativeT } from "../native-translations"

export type WslSidecar = {
  listener: {
    stop: () => Promise<void>
    onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  }
  url: string
  username: string
  password: string
}

export async function spawnWslSidecar(distro: string, opts: { healthTimeoutMs?: number } = {}): Promise<WslSidecar> {
  const runtime = await bundledWslRuntime(distro, false)
  const port = await allocatePort()
  const password = randomUUID()
  const identity = runtime.identity
  const child = spawn(
    "wsl",
    wslArgs(
      [
        "/usr/bin/env",
        "-i",
        `HOME=${identity.home}`,
        `USER=${identity.user}`,
        `LOGNAME=${identity.user}`,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "TMPDIR=/tmp",
        "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
        "OPENCODE_CLIENT=desktop",
        runtime.installedPath,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        "--desktop-sidecar-stdio",
      ],
      distro,
      identity.user,
      identity.home,
    ),
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined && ["SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"].includes(key.toUpperCase()),
        ),
      ),
    },
  )
  const listener = await connectWslChild(child, {
    port,
    password,
    timeoutMs: opts.healthTimeoutMs,
    identity: {
      type: "identity",
      source_sha: runtime.manifest.source_sha,
      version: runtime.manifest.version,
      channel: runtime.manifest.channel,
      executable_sha256: runtime.manifest.sha256,
      uid: identity.uid,
    },
  })
  return { listener, url: `http://127.0.0.1:${port}`, username: "bharatcode", password }
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
