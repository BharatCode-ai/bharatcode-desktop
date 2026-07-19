import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getLogger } from "./logging"
import { getStore } from "./store"
import type { SqliteMigrationProgress } from "../preload/types"
import { parseWslRuntimeManifest, wslRuntimeFilename, type WslRuntimeArch } from "./wsl-artifact"
import { trustedWindowsExecutables } from "./wsl-distro"
import { createWslPathTranslator } from "./wsl-path"
import { resolveWslLaunchIdentity, startWslRuntime } from "./wsl-runtime"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "sqlite"; progress: SqliteMigrationProgress }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000
const execFileAsync = promisify(execFile)

type SpawnLocalServerOptions = {
  needsMigration: boolean
  userDataPath: string
  onSqliteProgress?: (progress: SqliteMigrationProgress) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? loadShellEnv(shell, getLogger()) : null
  Object.assign(process.env, {
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    BHARATCODE_SHARE_BASE_URL:
      process.env.BHARATCODE_SHARE_BASE_URL ?? shellEnv?.BHARATCODE_SHARE_BASE_URL ?? "https://bharatcode.ai",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(password),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "sqlite") {
        refreshTimeout()
        options.onSqliteProgress?.(message.progress)
        return
      }
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      userDataPath: options.userDataPath,
      needsMigration: options.needsMigration,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, "bharatcode", password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function spawnWslServer(
  hostname: "127.0.0.1",
  port: number,
  password: string,
  options: {
    selectedDisplayName: string
    resourcesPath: string
    version: string
    arch: WslRuntimeArch
    channel: string
    hostEnv: Readonly<Record<string, string | undefined>>
    onSqliteProgress?: (progress: SqliteMigrationProgress) => void
    onStderr?: (message: string) => void
  },
) {
  const wslExecutable = trustedWindowsExecutables(options.hostEnv).wsl
  const execute = createWslExecute()
  const selected = await resolveWslLaunchIdentity({
    wslExecutable,
    selectedDisplayName: options.selectedDisplayName,
    execute,
  })
  const resourceDirectory = join(options.resourcesPath, "wsl-runtime")
  const manifestPath = join(resourceDirectory, "manifest.json")
  const manifest = parseWslRuntimeManifest(JSON.parse(await readFile(manifestPath, "utf8")))
  const runtime = await startWslRuntime({
    wslExecutable,
    execute,
    selectedDisplayName: options.selectedDisplayName,
    selectedUser: selected.user,
    selectedUid: selected.uid,
    home: selected.home,
    channel: options.channel,
    port,
    startedAtMs: Date.now(),
    password,
    runtimePath: join(resourceDirectory, wslRuntimeFilename(options.arch)),
    runtimeWindowsPath: join(resourceDirectory, wslRuntimeFilename(options.arch)),
    manifestPath,
    expectedSourceSha: manifest.source_sha,
    expectedVersion: options.version,
    expectedArch: options.arch,
    hostEnv: options.hostEnv,
    healthCheck: checkHealth,
    onSqliteProgress: options.onSqliteProgress,
    onStderr: options.onStderr,
  })
  return {
    listener: { stop: runtime.stop },
    health: { wait: Promise.resolve() },
    authorization: runtime.authorization,
    identity: runtime.identity,
    owned: {
      stop: runtime.stop,
      closeInput: runtime.closeInput,
      exited: runtime.exited,
    },
  }
}

export function translateWslProjectPath(
  path: string,
  options: {
    selectedDisplayName: string
    hostEnv: Readonly<Record<string, string | undefined>>
  },
) {
  const wslExecutable = trustedWindowsExecutables(options.hostEnv).wsl
  return createWslPathTranslator({
    wslExecutable,
    selectedDisplayName: options.selectedDisplayName,
    execute: createWslExecute(),
  }).translate(path, "linux")
}

export async function checkHealth(url: string, username?: string | null, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`${username ?? "bharatcode"}:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(password: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  env.BHARATCODE_SERVER_USERNAME = "bharatcode"
  env.BHARATCODE_SERVER_PASSWORD = password
  return env
}

function createWslExecute() {
  return async (executable: string, args: readonly string[]) => {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
