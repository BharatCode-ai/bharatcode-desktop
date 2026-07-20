import { spawn as nodeSpawn } from "node:child_process"
import { posix } from "node:path"
import type { Writable } from "node:stream"
import {
  decodeWslDesktopOutput,
  encodeWslDesktopRecord,
  readWslDesktopLines,
  type WslDesktopIdentity,
  type WslDesktopOutput,
} from "../../../opencode/src/server/wsl-desktop-transport"
import { installWslRuntime, verifyWslArtifact, type WslRuntimeArch } from "./wsl-artifact"
import { createSidecarAuthorizationPolicy } from "./sidecar-auth"
import { createWslPathTranslator } from "./wsl-path"
import type { WslExecute } from "./wsl-distro"
import { isSafeWslDisplayName } from "./wsl-contract"

type RuntimeChild = {
  stdin: Writable
  stdout: AsyncIterable<Uint8Array>
  stderr: { on(event: "data" | "end", listener: (chunk?: Buffer) => void): unknown }
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type WslRuntimeSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    env: Record<string, string>
    shell: false
    windowsHide: true
    stdio: ["pipe", "pipe", "pipe"]
  },
) => RuntimeChild

type ExpectedIdentity = { sourceSha: string; version: string; executableSha256: string; uid: number }

export async function resolveWslLaunchIdentity(input: {
  wslExecutable: string
  selectedDisplayName: string
  execute: WslExecute
}) {
  if (!isSafeWslDisplayName(input.selectedDisplayName)) throw new Error("Invalid selected WSL distribution")
  const prefix = ["--distribution", input.selectedDisplayName, "--exec"] as const
  const uidText = closedLine((await input.execute(input.wslExecutable, [...prefix, "/usr/bin/id", "-u"])).stdout)
  if (!/^(?:0|[1-9]\d*)$/u.test(uidText)) throw new Error("Selected WSL UID is invalid")
  const uid = Number(uidText)
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Selected WSL user must be non-root")
  const user = closedLine((await input.execute(input.wslExecutable, [...prefix, "/usr/bin/id", "-un"])).stdout)
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user)) throw new Error("Selected WSL username is invalid")
  const passwd = closedLine(
    (await input.execute(input.wslExecutable, [...prefix, "/usr/bin/getent", "passwd", user])).stdout,
  ).split(":")
  if (passwd.length !== 7 || passwd[0] !== user || passwd[2] !== String(uid)) {
    throw new Error("Selected WSL passwd identity does not match")
  }
  const home = passwd[5]
  if (!posix.isAbsolute(home) || posix.normalize(home) !== home || /[\u0000\r\n]/u.test(home)) {
    throw new Error("Selected WSL home is invalid")
  }
  return { user, uid, home }
}

export function createWslRuntimeProtocolGate(expected: ExpectedIdentity) {
  let count = 0
  let identity = false
  let ready = false
  let terminal = false
  return {
    accept(record: WslDesktopOutput) {
      count += 1
      if (count > 4_096) throw new Error("WSL runtime exceeded 4096 protocol records")
      if (terminal) throw new Error("WSL runtime emitted a record after its terminal result")
      if (record.type === "identity") {
        if (identity || ready) throw new Error("WSL runtime emitted duplicate or late identity")
        if (
          record.source_sha !== expected.sourceSha ||
          record.version !== expected.version ||
          record.executable_sha256 !== expected.executableSha256 ||
          record.uid !== expected.uid
        ) {
          throw new Error("WSL runtime identity does not match the verified candidate")
        }
        identity = true
        return
      }
      if (record.type === "sqlite") {
        if (!identity || ready) throw new Error("WSL runtime emitted sqlite progress out of order")
        return
      }
      if (record.type === "ready") {
        if (!identity || ready) throw new Error("WSL runtime emitted duplicate or premature ready")
        ready = true
        return
      }
      terminal = true
      if (record.type === "stopped" && !ready) throw new Error("WSL runtime stopped before ready")
    },
    state() {
      return { count, identity, ready, terminal }
    },
  }
}

export async function startWslRuntime(input: {
  wslExecutable: string
  execute: WslExecute
  spawn?: WslRuntimeSpawn
  selectedDisplayName: string
  selectedUser: string
  selectedUid: number
  home: string
  channel: string
  port: number
  startedAtMs: number
  password: string
  runtimePath: string
  runtimeWindowsPath: string
  manifestPath: string
  expectedSourceSha: string
  expectedVersion: string
  expectedArch: WslRuntimeArch
  hostEnv: Readonly<Record<string, string | undefined>>
  healthCheck: (url: string, username?: string | null, password?: string | null) => Promise<boolean>
  onSqliteProgress?: (progress: Extract<WslDesktopOutput, { type: "sqlite" }>["progress"]) => void
  onStderr?: (message: string) => void
}) {
  const manifest = await verifyWslArtifact({
    runtimePath: input.runtimePath,
    manifestPath: input.manifestPath,
    expectedSourceSha: input.expectedSourceSha,
    expectedVersion: input.expectedVersion,
    expectedArch: input.expectedArch,
  })
  const runtimeSourceLinuxPath = await createWslPathTranslator({
    wslExecutable: input.wslExecutable,
    selectedDisplayName: input.selectedDisplayName,
    execute: input.execute,
  }).translate(input.runtimeWindowsPath, "linux")
  const installed = await installWslRuntime({
    wslExecutable: input.wslExecutable,
    execute: input.execute,
    selectedDisplayName: input.selectedDisplayName,
    selectedUser: input.selectedUser,
    selectedUid: input.selectedUid,
    home: input.home,
    channel: input.channel,
    runtimeSourceLinuxPath,
    manifest,
  })
  const child = (input.spawn ?? spawnRuntime)(input.wslExecutable, runtimeArgs(input, installed.installedPath), {
    env: hostEnvironment(input.hostEnv),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const gate = createWslRuntimeProtocolGate({
    sourceSha: manifest.source_sha,
    version: manifest.version,
    executableSha256: manifest.sha256,
    uid: input.selectedUid,
  })
  const ready = deferred<WslDesktopIdentity>()
  const stopped = deferred<void>()
  const exited = deferred<void>()
  void stopped.promise.catch(() => undefined)
  let acceptedIdentity: WslDesktopIdentity | undefined
  let credentialError: Error | undefined
  let protocolFailure: Error | undefined
  let stderrPending = ""

  child.once("exit", () => {
    exited.resolve()
    if (!gate.state().ready) ready.reject(new Error("WSL runtime exited before ready"))
  })

  child.stderr.on("data", (chunk) => {
    stderrPending += chunk?.toString("utf8") ?? ""
    if (stderrPending.includes(input.password)) {
      stderrPending = ""
      credentialError = new Error("WSL runtime exposed its credential on stderr")
      ready.reject(credentialError)
      return
    }
    const safeLength = Math.max(0, stderrPending.length - Math.max(input.password.length - 1, 0))
    if (safeLength === 0) return
    input.onStderr?.(stderrPending.slice(0, safeLength))
    stderrPending = stderrPending.slice(safeLength)
  })
  child.stderr.on("end", () => {
    if (stderrPending && !credentialError) input.onStderr?.(stderrPending)
    stderrPending = ""
  })

  const consume = (async () => {
    try {
      for await (const line of readWslDesktopLines(child.stdout)) {
        const record = decodeWslDesktopOutput(line)
        gate.accept(record)
        if (record.type === "identity") acceptedIdentity = record
        if (record.type === "sqlite") input.onSqliteProgress?.(record.progress)
        if (record.type === "ready") {
          if (credentialError) throw credentialError
          ready.resolve(acceptedIdentity!)
        }
        if (record.type === "error") throw new Error(`WSL runtime returned ${record.code}`)
        if (record.type === "stopped") {
          stopped.resolve()
          return
        }
      }
      throw new Error("WSL runtime stdout ended without a terminal result")
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      protocolFailure = failure
      ready.reject(failure)
      stopped.reject(failure)
      throw failure
    }
  })()
  void consume.catch(() => undefined)

  const startRecord = encodeWslDesktopRecord({
    type: "start",
    hostname: "127.0.0.1",
    port: input.port,
    started_at_ms: input.startedAtMs,
    username: "bharatcode",
    password: input.password,
  })
  try {
    await writeRecord(child.stdin, startRecord)
  } finally {
    startRecord.fill(0)
  }

  let identity: WslDesktopIdentity
  try {
    identity = await ready.promise
    const origin = `http://127.0.0.1:${input.port}`
    if (await input.healthCheck(origin)) throw new Error("WSL runtime health accepted an unauthenticated request")
    if (!(await input.healthCheck(origin, "bharatcode", input.password))) {
      throw new Error("WSL runtime authenticated health check failed")
    }
    // Drain records already queued with ready before accepting the authenticated origin.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (credentialError) throw credentialError
    if (protocolFailure) throw protocolFailure
    if (gate.state().terminal) throw new Error("WSL runtime reached a terminal result during startup")
    const authorization = createSidecarAuthorizationPolicy({
      origin,
      username: "bharatcode",
      password: input.password,
    })
    let stopping: Promise<void> | undefined
    return {
      origin,
      identity,
      authorization,
      exited: exited.promise,
      stop() {
        if (stopping) return stopping
        stopping = writeRecord(child.stdin, encodeWslDesktopRecord({ type: "stop" }))
          .then(() => Promise.all([stopped.promise, exited.promise]))
          .then(() => undefined)
        return stopping
      },
      closeInput() {
        child.stdin.end()
      },
    }
  } catch (error) {
    child.stdin.end()
    throw error
  }
}

function runtimeArgs(
  input: {
    selectedDisplayName: string
    selectedUser: string
    home: string
    channel: string
    port: number
  },
  installedPath: string,
) {
  return [
    "--distribution",
    input.selectedDisplayName,
    "--user",
    input.selectedUser,
    "--cd",
    input.home,
    "--exec",
    "/usr/bin/env",
    "-i",
    `HOME=${input.home}`,
    `USER=${input.selectedUser}`,
    `LOGNAME=${input.selectedUser}`,
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `BHARATCODE_CHANNEL=${input.channel}`,
    "TMPDIR=/tmp",
    installedPath,
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--desktop-sidecar-stdio",
  ]
}

function hostEnvironment(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    ["SystemRoot", "WINDIR", "PATH", "ComSpec", "PATHEXT", "TEMP", "TMP"].flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]!]],
    ),
  )
}

function spawnRuntime(executable: string, args: readonly string[], options: Parameters<WslRuntimeSpawn>[2]) {
  return nodeSpawn(executable, [...args], options) as unknown as RuntimeChild
}

function writeRecord(stream: Writable, record: Uint8Array) {
  return new Promise<void>((resolve, reject) => {
    stream.write(record, (error) => (error ? reject(error) : resolve()))
  })
}

function closedLine(output: string) {
  const value = output.replace(/\r?\n$/u, "")
  if (!value || /[\u0000\r\n]/u.test(value)) throw new Error("Selected WSL identity output is malformed")
  return value
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
