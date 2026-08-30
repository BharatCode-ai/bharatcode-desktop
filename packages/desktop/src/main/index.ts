import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { fileURLToPath } from "node:url"
import type { Event } from "electron"
import { app, BrowserWindow, dialog, shell } from "electron"

import contextMenu from "electron-context-menu"

import { createBharatCodeAccountClient, isBharatCodeAuthCallback } from "./bharatcode-auth"
import { createSidecarAuthorizationPolicy, type SidecarAuthorizationPolicy } from "./sidecar-auth"
import { BRANDING, appIdForChannel, productNameForChannel } from "./branding"
import {
  ensureCapabilityRuntime,
  getCapabilitySnapshotFromStore,
  installStoredCapability,
  setStoredCapabilityEnabled,
  uninstallStoredCapability,
} from "./capabilities"
import type { InitStep, ServerReadyData, SqliteMigrationProgress } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { transcribeDictationAudio } from "./dictation"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  spawnWslServer,
  translateWslProjectPath,
  type SidecarListener,
} from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { migrate } from "./migrate"
import { getStore } from "./store"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { Deferred, Effect, Fiber } from "effect"
import { bundledRecoveryExecutable, createStartupRecovery } from "./startup-recovery"
import { reportStartupFailure } from "./startup-failure"
import { createWslService } from "./wsl-distro"
import {
  configureWslForControlledRelaunch,
  WslLifecycleFailure,
  classifyWslLaunchFailure,
  createWslLifecycle,
  retainWslAuthorizationWhileRunning,
  rewriteWslProjectDeepLinks,
} from "./wsl-lifecycle"
import { completeWslAcceptanceOutput, resolveWslAcceptanceInvocation, runPackagedWslAcceptance } from "./wsl-acceptance"

const TEST_ONBOARDING = process.env.BHARATCODE_TEST_ONBOARDING === "1" || process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
let sidecarAuthorization: SidecarAuthorizationPolicy | undefined
let accountClient: ReturnType<typeof createBharatCodeAccountClient> | undefined
let wslLifecycle: ReturnType<typeof createWslLifecycle> | undefined
let selectedWslDisplayName: string | undefined
const pendingAccountCallbacks: string[] = []

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []
const WSL_SELECTION_KEY = "wslSelectionV1"
const wslService = createWslService({
  platform: process.platform,
  env: process.env,
  readState: () => getStore().get(WSL_SELECTION_KEY),
  writeState: (value) => getStore().set(WSL_SELECTION_KEY, value),
})

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

async function revalidateWslSelection() {
  const snapshot = await wslService.snapshot()
  if (!snapshot.enabled) throw new WslLifecycleFailure("selection-required")
  if (snapshot.status.phase === "error") throw new WslLifecycleFailure(snapshot.status.code)
  if (snapshot.status.phase !== "ready" || !snapshot.selectedDisplayName) {
    throw new WslLifecycleFailure("selection-invalid")
  }
  selectedWslDisplayName = snapshot.selectedDisplayName
}

async function rendererWslSnapshot() {
  const snapshot = await wslService.snapshot()
  return wslLifecycle?.projectSnapshot(snapshot) ?? snapshot
}

async function translateProjectPaths(paths: readonly string[]) {
  const snapshot = await wslService.snapshot()
  if (!snapshot.enabled) return [...paths]
  if (!wslLifecycle) throw new WslLifecycleFailure("path-translation")
  return wslLifecycle.translateProjectPaths(paths, (path) => {
    if (!selectedWslDisplayName) throw new WslLifecycleFailure("selection-invalid")
    return translateWslProjectPath(path, { selectedDisplayName: selectedWslDisplayName, hostEnv: process.env })
  })
}

async function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  const translated = await rewriteWslProjectDeepLinks(urls, translateProjectPaths)
  pendingDeepLinks.push(...translated)
  if (mainWindow) sendDeepLinks(mainWindow, translated)
}

function handleIncomingDeepLinks(urls: string[]) {
  for (const url of urls) {
    if (!isBharatCodeAuthCallback(url)) {
      void emitDeepLinks([url]).catch((error) => logger.warn("failed to translate WSL project deep link", error))
      continue
    }
    if (!accountClient) {
      pendingAccountCallbacks.push(url)
      continue
    }
    void accountClient.completeSignIn(url).catch((error) => {
      logger.warn("failed to handle BharatCode auth callback", error)
    })
  }
}

function supportedDeepLinks(argv: string[]) {
  return argv.filter((arg: string) => arg.startsWith(`${BRANDING.protocol}://`))
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  sidecarAuthorization?.invalidate()
  sidecarAuthorization = undefined
  accountClient = undefined
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

async function relaunchDesktop() {
  try {
    await killSidecar()
  } finally {
    app.relaunch()
    app.exit(0)
  }
}

function requireAccountClient() {
  if (!accountClient) throw new Error("The BharatCode account runtime is unavailable.")
  return accountClient
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const mainBundleDir = dirname(fileURLToPath(import.meta.url))

function desktopResourcesPath() {
  if (app.isPackaged) return process.resourcesPath
  return resolve(mainBundleDir, "..", "..", "resources")
}

function syncCapabilityRuntime() {
  return ensureCapabilityRuntime({
    getStore,
    resourcesPath: desktopResourcesPath(),
  })
}

function capabilitySnapshot() {
  return getCapabilitySnapshotFromStore({
    getStore,
    resourcesPath: desktopResourcesPath(),
  })
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"
  const appId = app.isPackaged ? appIdForChannel(CHANNEL) : appIdForChannel("dev")
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `bharatcode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? productNameForChannel(CHANNEL) : productNameForChannel("dev"))
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))
  const startupRecovery = createStartupRecovery({
    executable: bundledRecoveryExecutable(desktopResourcesPath()),
  })

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = supportedDeepLinks(argv)
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      handleIncomingDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    handleIncomingDeepLinks([url])
  })

  app.on("before-quit", () => {
    void killSidecar()
  })

  app.on("will-quit", () => {
    void killSidecar()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    void relaunchDesktop()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killSidecar().finally(() => app.exit(0))
    })
  }
  process.on("exit", () => wslLifecycle?.closeInput())

  const serverReady = Deferred.makeUnsafe<ServerReadyData>()
  const loadingComplete = Deferred.makeUnsafe<void>()

  registerIpcHandlers({
    inspectRecovery: () => startupRecovery.inspect(),
    runRecovery: (action) => startupRecovery.run(action),
    killSidecar: () => killSidecar(),
    awaitInitialization: Effect.fnUntraced(
      function* (sendStep) {
        sendStep(initStep)
        const listener = (step: InitStep) => sendStep(step)
        initEmitter.on("step", listener)
        try {
          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })
          return res
        } finally {
          initEmitter.off("step", listener)
        }
      },
      (e) => Effect.runPromise(e),
    ),
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getWslSnapshot: () => rendererWslSnapshot(),
    configureWsl: (update) =>
      configureWslForControlledRelaunch(update, {
        snapshot: rendererWslSnapshot,
        configure: wslService.configure,
        relaunch: relaunchDesktop,
      }),
    retryWsl: async () => {
      const snapshot = await wslService.retry()
      if (snapshot.enabled && snapshot.status.phase === "ready" && wslLifecycle?.status().phase === "error") {
        await wslLifecycle.retry()
      }
      return wslLifecycle?.projectSnapshot(snapshot) ?? snapshot
    },
    translateProjectPaths,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killSidecar),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    getAccountStatus: () => requireAccountClient().getAccountStatus(),
    beginSignIn: async (options) => {
      const authorization = await requireAccountClient().beginSignIn({
        selectAccount: options?.selectAccount === true,
      })
      await shell.openExternal(authorization.url)
      return {
        state: options?.selectAccount ? ("switching" as const) : ("authorizing" as const),
        authenticated: false,
        checkedAt: new Date().toISOString(),
      }
    },
    completeSignIn: () => requireAccountClient().getAccountStatus(),
    logout: () => requireAccountClient().logout(),
    refreshAccountStatus: () => requireAccountClient().refreshAccountStatus(),
    transcribeDictation: (audio) => transcribeDictationAudio(audio),
    getCapabilitySnapshot: () => capabilitySnapshot(),
    installCapability: async (id) => {
      installStoredCapability({ getStore, resourcesPath: desktopResourcesPath(), id })
      return syncCapabilityRuntime()
    },
    setCapabilityEnabled: async (id, enabled) => {
      setStoredCapabilityEnabled({ getStore, resourcesPath: desktopResourcesPath(), id, enabled })
      return syncCapabilityRuntime()
    },
    uninstallCapability: async (id) => {
      uninstallStoredCapability({ getStore, resourcesPath: desktopResourcesPath(), id })
      return syncCapabilityRuntime()
    },
    applyCapabilityRuntime: () => syncCapabilityRuntime(),
  })

  yield* Effect.promise(() => app.whenReady())
  registerRendererProtocol()

  let overlay: BrowserWindow | null = null
  const recoveryStatus = yield* Effect.promise(() => startupRecovery.inspect())
  if (recoveryStatus.state !== "ready") {
    setInitStep({ phase: "recovery_waiting" })
    overlay = createLoadingWindow()
    yield* Effect.promise(() => startupRecovery.waitUntilReady(recoveryStatus))
    setInitStep({ phase: "server_waiting" })
  }

  yield* Effect.promise(() => syncCapabilityRuntime()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to sync capability runtime", error)
      }),
    ),
  )

  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient(BRANDING.protocol)
  setDockIcon()
  setupAutoUpdater()
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const needsMigration = ((): boolean => {
    if (process.env.OPENCODE_DB === ":memory:") return false

    const xdg = process.env.XDG_DATA_HOME
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
    return !existsSync(join(base, "opencode", "opencode.db"))
  })()
  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()
  const sidecarID = randomUUID()
  accountClient = createBharatCodeAccountClient({
    getConnection: async () => ({ url, username: "bharatcode", password }),
  })
  wslLifecycle = createWslLifecycle({
    revalidate: revalidateWslSelection,
    startOwned: async () => {
      if (!selectedWslDisplayName) throw new WslLifecycleFailure("selection-invalid")
      if (process.arch !== "x64" && process.arch !== "arm64") {
        throw new WslLifecycleFailure("prerequisite-missing")
      }
      try {
        const result = await spawnWslServer(hostname, port, password, {
          selectedDisplayName: selectedWslDisplayName,
          resourcesPath: process.resourcesPath,
          version: app.getVersion(),
          arch: process.arch,
          channel: CHANNEL,
          hostEnv: process.env,
          onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
          onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        })
        sidecarAuthorization?.invalidate()
        sidecarAuthorization = result.authorization
        return result.owned
      } catch (error) {
        throw classifyWslLaunchFailure(error)
      }
    },
    onStatus: (status) => {
      sidecarAuthorization = retainWslAuthorizationWhileRunning(status, sidecarAuthorization)
    },
  })

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const wslSnapshot = yield* Effect.promise(() => wslService.snapshot())
    const spawned = yield* Effect.promise(async () => {
      if (wslSnapshot.enabled) {
        await wslLifecycle!.start()
        return {
          listener: { stop: () => wslLifecycle!.stop() },
          health: { wait: Promise.resolve() },
        }
      }
      sidecarAuthorization = createSidecarAuthorizationPolicy({ origin: url, username: "bharatcode", password })
      return spawnLocalServer(hostname, port, password, {
        needsMigration,
        userDataPath: app.getPath("userData"),
        onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      })
    })
    const { listener, health } = spawned
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      sidecarID,
    })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(Effect.forkChild)

  if (needsMigration) {
    const show = yield* loadingTask.pipe(
      Fiber.await,
      Effect.timeout("1 second"),
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    )
    if (show) {
      overlay = createLoadingWindow()
      yield* Effect.sleep("1 second")
    }
  }

  yield* Fiber.await(loadingTask)
  setInitStep({ phase: "done" })

  if (overlay) yield* Deferred.await(loadingComplete)

  for (const callback of pendingAccountCallbacks.splice(0)) {
    void requireAccountClient()
      .completeSignIn(callback)
      .catch((error) => logger.warn("failed to complete BharatCode sign-in", error))
  }

  mainWindow = createMainWindow(() => sidecarAuthorization)
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void checkForUpdates(true, killSidecar)
      },
      relaunch: () => {
        void relaunchDesktop()
      },
    })
  }

  overlay?.close()
})

let dispatch: ReturnType<typeof resolveWslAcceptanceInvocation> | { readonly kind: "rejected" }
try {
  dispatch = resolveWslAcceptanceInvocation(process.argv.slice(1), {
    packaged: app.isPackaged,
    platform: process.platform,
  })
} catch {
  process.stderr.write("Packaged WSL acceptance invocation rejected\n")
  app.exit(1)
  dispatch = { kind: "rejected" }
}

if (dispatch.kind === "acceptance") {
  void runPackagedWslAcceptance(dispatch.input).then(
    (record) => {
      completeWslAcceptanceOutput(record, process.stdout, (code) => {
        if (code !== 0) process.stderr.write("Packaged WSL acceptance output failed\n")
        app.exit(code)
      })
    },
    () => {
      process.stderr.write("Packaged WSL acceptance failed\n")
      app.exit(1)
    },
  )
} else if (dispatch.kind === "ordinary") {
  void Effect.runPromise(main).catch((error) =>
    reportStartupFailure(
      {
        log: (failure) => logger?.error("desktop startup failed", failure),
        showError: (title, message) => dialog.showErrorBox(title, message),
        exit: (code) => app.exit(code),
      },
      error,
    ),
  )
}
