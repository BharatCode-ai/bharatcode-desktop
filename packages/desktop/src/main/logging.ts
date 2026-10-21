import { supportErrors } from "./support-errors"
import { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, netLog, shell } from "electron"
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir, tmpdir, release } from "node:os"
import { CHANNEL } from "./constants"
import { createSupportExporter } from "./support-export"
import { collectSupportMetadata } from "./support-metadata"
import { createSupportBundle, type SupportAuthSummary } from "./support-bundle"
import { nativeT } from "./native-translations"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
const NET_LOG_SIZE = 20 * 1024 * 1024

let root = ""
let run = ""
let netLogPath: string | undefined

let logger: MainLogger
export const getLogger = () => logger

export function initLogging() {
  initRunDirectory()
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.resolvePathFn = (_vars, message) =>
    join(
      run,
      `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
    )
  log.initialize({ preload: false, spyRendererConsole: true })
  initConsoleTransport()
  cleanup()
  return (logger = log)
}

export function initCrashReporter() {
  const dir = join(app.getPath("userData"), "Crashpad")
  mkdirSync(dir, { recursive: true })
  app.setPath("crashDumps", dir)
  crashReporter.start({ uploadToServer: false, compress: true })
  write("crash", "crash reporter started", { path: dir })
}

export async function startNetLog() {
  if (netLog.currentlyLogging) return
  netLogPath = join(run, "network.netlog")
  await netLog.startLogging(netLogPath, { captureMode: "default", maxFileSize: NET_LOG_SIZE })
  write("network", "net log started", { path: netLogPath })
}

// Recovery actions can run before account/runtime initialization.
let supportAuth = () => createSupportBundle({}).auth
export function setSupportAuthReader(read: () => SupportAuthSummary) {
  supportAuth = read
}

export const exportDebugLogs = createSupportExporter({
  directory: () => app.getPath("downloads"),
  input: async () => {
    const metadata = await collectSupportMetadata({ channel: CHANNEL, platform: process.platform, home: homedir(), temp: tmpdir(), env: process.env }).catch(() => ({}))
    return {
      ...metadata,
      version: app.getVersion(), platform: process.platform, release: release(), arch: process.arch, channel: CHANNEL,
      auth: supportAuth(), errors: supportErrors.summary(),
    }
  },
  reveal: (filename) => shell.showItemInFolder(filename),
  failure: () => new Error(nativeT("desktop.support.error.export")),
})

export function write(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  if (level === "error") {
    if (name === "renderer" || name === "window") supportErrors.record("renderer")
    if (name === "utility") supportErrors.record("sidecar")
  }
  if (!run) return
  const scoped = log.scope(safeLogName(name))
  if (extra !== undefined) {
    scoped[level](message, extra)
    return
  }
  scoped[level](message)
}

export function tail(): string {
  try {
    const path = log.transports.file.getFile().path
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

function initRunDirectory() {
  root = join(app.getPath("userData"), "logs")
  run = join(root, stamp())
  mkdirSync(run, { recursive: true })
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

function cleanup() {
  const dir = root || dirname(log.transports.file.getFile().path)
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (info.mtimeMs < cutoff) rmSync(file, { recursive: true, force: true })
    } catch {
      continue
    }
  }
}

function initConsoleTransport() {
  if (app.isPackaged) {
    log.transports.console.level = false
    return
  }

  const write = log.transports.console.writeFn.bind(log.transports.console)
  log.transports.console.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      log.transports.console.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}
