import type { ChildProcessWithoutNullStreams } from "node:child_process"
import {
  decodeWslDesktopOutput,
  encodeWslDesktopRecord,
  readWslDesktopLines,
  type WslDesktopIdentity,
} from "../../../../opencode/src/server/wsl-desktop-transport"

export async function connectWslChild(
  child: ChildProcessWithoutNullStreams,
  input: {
    identity: WslDesktopIdentity
    port: number
    password: string
    timeoutMs?: number
    fetch?: typeof fetch
  },
) {
  const ready = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<never>()
  for (const pending of [ready, stopped, failed]) void pending.promise.catch(() => undefined)
  let identity = false
  let announcedReady = false
  let terminal = false
  let stopRequested = false
  let exitResult: [number | null, NodeJS.Signals | null] | undefined
  let stopPromise: Promise<void> | undefined
  const listeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  const fail = () => {
    failed.reject(new Error("WSL runtime transport failed"))
    child.stdin.end()
    child.kill()
  }
  child.once("error", fail)
  child.stdin.on("error", fail)
  child.once("close", (code, signal) => {
    exitResult = [code, signal]
    exited.resolve()
    if (!stopRequested) failed.reject(new Error("WSL runtime exited"))
    for (const listener of listeners) listener(code, signal)
    listeners.clear()
  })
  // Output is not a diagnostics channel: never forward child errors, paths or
  // credentials to the log/renderer. stdout is exclusively the closed protocol.
  child.stderr.resume()
  const consume = (async () => {
    let records = 0
    for await (const line of readWslDesktopLines(child.stdout)) {
      const record = decodeWslDesktopOutput(line)
      if (++records > 4096 || terminal) throw new Error("Invalid WSL protocol order")
      if (record.type === "identity") {
        if (
          identity ||
          announcedReady ||
          record.source_sha !== input.identity.source_sha ||
          record.version !== input.identity.version ||
          record.channel !== input.identity.channel ||
          record.executable_sha256 !== input.identity.executable_sha256 ||
          record.uid !== input.identity.uid
        )
          throw new Error("WSL runtime identity mismatch")
        identity = true
      } else if (record.type === "sqlite") {
        if (!identity || announcedReady) throw new Error("Invalid WSL progress order")
      } else if (record.type === "ready") {
        if (!identity || announcedReady) throw new Error("Invalid WSL ready order")
        announcedReady = true
        ready.resolve()
      } else if (record.type === "stopped") {
        if (!announcedReady || !stopRequested) throw new Error("Unexpected WSL stop")
        terminal = true
        stopped.resolve()
      } else throw new Error("WSL runtime failed")
    }
    if (!terminal) throw new Error("WSL protocol ended without acknowledgement")
  })()
  void consume.catch(fail)
  const write = (record: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      child.stdin.write(record, (error) => (error ? reject(new Error("WSL control write failed")) : resolve()))
    })
  const url = `http://127.0.0.1:${input.port}`
  const healthAbort = new AbortController()
  try {
    await bounded(
      Promise.race([
        failed.promise,
        (async () => {
          await write(
            encodeWslDesktopRecord({
              type: "start",
              hostname: "127.0.0.1",
              port: input.port,
              started_at_ms: Date.now(),
              username: "bharatcode",
              password: input.password,
            }),
          )
          await ready.promise
          const request = input.fetch ?? fetch
          while (!healthAbort.signal.aborted) {
            const signal = AbortSignal.any([healthAbort.signal, AbortSignal.timeout(3_000)])
            const probe = await request(`${url}/global/health`, { redirect: "manual", signal }).catch(() => undefined)
            if (probe) {
              const status = probe.status
              await probe.body?.cancel()
              if (status !== 401) throw new Error("WSL runtime accepts anonymous requests")
              const authenticated = await request(`${url}/global/health`, {
                redirect: "manual",
                signal,
                headers: { authorization: `Basic ${Buffer.from(`bharatcode:${input.password}`).toString("base64")}` },
              })
              const healthy = authenticated.status === 200
              await authenticated.body?.cancel()
              if (!healthy) throw new Error("WSL runtime credential rejected")
              return
            }
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer)
                healthAbort.signal.removeEventListener("abort", done)
                resolve()
              }
              const timer = setTimeout(done, 100)
              healthAbort.signal.addEventListener("abort", done, { once: true })
            })
          }
          throw new Error("WSL health check aborted")
        })(),
      ]),
      input.timeoutMs ?? 30_000,
    )
    if (exitResult) throw new Error("WSL runtime exited during startup")
  } catch {
    healthAbort.abort()
    child.stdin.end()
    child.kill()
    await bounded(exited.promise, 5_000).catch(() => undefined)
    throw new Error("WSL runtime startup failed")
  } finally {
    healthAbort.abort()
  }
  return {
    stop() {
      return (stopPromise ??= (async () => {
        stopRequested = true
        try {
          await bounded(
            Promise.race([
              failed.promise,
              (async () => {
                await write(encodeWslDesktopRecord({ type: "stop" }))
                child.stdin.end()
                await stopped.promise
                await exited.promise
                await consume
                if (exitResult?.[0] !== 0) throw new Error("WSL runtime exit failed")
              })(),
            ]),
            5_000,
          )
        } catch {
          child.stdin.end()
          child.kill()
          await bounded(exited.promise, 5_000).catch(() => undefined)
          throw new Error("WSL runtime shutdown failed")
        }
      })())
    },
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      if (exitResult) {
        listener(...exitResult)
        return
      }
      listeners.add(listener)
    },
  }
}

async function bounded<T>(promise: Promise<T>, duration: number) {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("WSL runtime timed out")), duration)
    }),
  ]).finally(() => clearTimeout(timer))
}
