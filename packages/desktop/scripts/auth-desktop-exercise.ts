/**
 * Actual Linux dev Electron acceptance, not a packaged OS-handler test.
 * Build the Node sidecar and electron-vite output first, then run from desktop:
 * NODE_EXTRA_CA_CERTS=/fixture/ca.pem dbus-run-session -- xvfb-run -a \
 *   bun scripts/auth-desktop-exercise.ts --fixture=/fixture/env.json
 *
 * Uses the real renderer preload/IPC, main process, second-instance dispatch,
 * utility-process sidecar and shared account service. Only synthetic fixture
 * consent is automated. Never registers a protocol or reads an existing profile.
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createServer } from "node:net"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { BharatCodeAuth } from "@opencode-ai/core/bharatcode-auth"
import { approveLocalFixture } from "../../opencode/script/auth-local-fixture"

const file = Bun.argv[2]?.startsWith("--fixture=") ? Bun.argv[2].slice(10) : undefined
if (process.platform !== "linux" || !file || Bun.argv.length !== 3 || !process.env.DISPLAY) {
  throw new Error("Run this Linux-only harness under Xvfb with --fixture=/absolute/path/env.json.")
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification must remain enabled.")
const fixture = (await Bun.file(file).json()) as { authOrigin: string; ca: string; userId: string }
const issuer = BharatCodeAuth.issuer({ BHARATCODE_AUTH_URL: fixture.authOrigin })
const host = new URL(issuer).hostname
if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && !host.endsWith(".localhost")) {
  throw new Error("Desktop acceptance only accepts a local synthetic Auth fixture.")
}
if (process.env.NODE_EXTRA_CA_CERTS !== fixture.ca) throw new Error("Start Bun with the fixture's NODE_EXTRA_CA_CERTS.")
const desktop = path.resolve(import.meta.dir, "..")
const electron = path.join(desktop, "node_modules/electron/dist/electron")
await fs.access(electron)
await fs.access(path.join(desktop, "out/main/index.js"))
// The dev entry point selects 9222. Do not attach to another app's debugger.
await new Promise<void>((resolve, reject) => {
  const probe = createServer()
  probe.once("error", () => reject(new Error("Desktop debug port 9222 is occupied; leave that app untouched.")))
  probe.listen(9222, "127.0.0.1", () => probe.close(() => resolve()))
})

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bharatcode-desktop-auth-"))
await Promise.all(
  ["home", "data", "config", "cache", "state", "runtime", "tmp", "bin"].map((dir) =>
    fs.mkdir(path.join(root, dir), { mode: 0o700 }),
  ),
)
await fs.copyFile(path.join(import.meta.dir, "auth-local-browser"), path.join(root, "bin/xdg-open"))
await fs.chmod(path.join(root, "bin/xdg-open"), 0o700)
const authorization = Promise.withResolvers<string>()
const captureSecret = randomUUID()
const capture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${captureSecret}`) {
      return new Response(null, { status: 403 })
    }
    const value = (await request.json()) as { url?: string }
    if (!value.url) return new Response(null, { status: 400 })
    const url = new URL(value.url)
    if (url.origin !== fixture.authOrigin || url.pathname !== "/auth/v1/oauth/authorize") {
      return new Response(null, { status: 400 })
    }
    authorization.resolve(value.url)
    return new Response(null, { status: 204 })
  },
})
const env = {
  PATH: `${path.join(root, "bin")}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  HOME: path.join(root, "home"),
  OPENCODE_TEST_HOME: path.join(root, "home"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_RUNTIME_DIR: path.join(root, "runtime"),
  TMPDIR: path.join(root, "tmp"),
  BHARATCODE_CHANNEL: "dev",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  BHARATCODE_AUTH_URL: fixture.authOrigin,
  NODE_EXTRA_CA_CERTS: fixture.ca,
  BHARATCODE_AUTH_BUN: process.execPath,
  BHARATCODE_AUTH_CAPTURE_SCRIPT: path.join(import.meta.dir, "auth-local-capture.ts"),
  BHARATCODE_AUTH_CAPTURE_URL: `http://127.0.0.1:${capture.port}/`,
  BHARATCODE_AUTH_CAPTURE_SECRET: captureSecret,
  BROWSER: path.join(root, "bin/xdg-open"),
  // Skip interactive shell/profile probing, including the user's real rc files.
  SHELL: "/bin/false",
  DISPLAY: process.env.DISPLAY,
  ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
}
// Auth's global paths are evaluated on import; all credential operations below
// target this freshly created profile, never the installed app's auth store.
Object.assign(process.env, env)
const child = Bun.spawn([electron, "--disable-dev-shm-usage", "--disable-gpu", desktop], {
  env,
  cwd: root,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
})
// Drain process output privately; it may include synthetic callback details.
const stdout = new Response(child.stdout).text()
const stderr = new Response(child.stderr).text()
let socket: WebSocket | undefined
let phase = "startup"
const deadline = setTimeout(() => child.kill(), 150_000)
const emit = (event: string, details: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...details }))

try {
  emit("desktop-launch", { isolatedProfile: true, protocolRegistration: false })
  const target = await until(async () => {
    if (child.exitCode !== null) throw new Error("The dev Desktop exited during startup.")
    const response = await fetch("http://127.0.0.1:9222/json/list").catch(() => undefined)
    if (!response?.ok) return
    const pages = (await response.json()) as { url: string; type: string; webSocketDebuggerUrl: string }[]
    return pages.find((page) => page.type === "page" && page.url.startsWith("oc://renderer/"))
  }, 60_000)
  const connected = Promise.withResolvers<void>()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener("open", () => connected.resolve(), { once: true })
  socket.addEventListener("error", () => connected.reject(new Error("Desktop debugger connection failed.")), {
    once: true,
  })
  await bounded(connected.promise, 5000)
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>()
  let sequence = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown }
    if (!message.id) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) request?.reject(new Error("Desktop debugger command failed."))
    else request?.resolve(message.result)
  })
  const evaluate = async (expression: string) => {
    const id = ++sequence
    const result = Promise.withResolvers<unknown>()
    pending.set(id, result)
    socket!.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
    const response = (await bounded(result.promise, 65_000)) as {
      exceptionDetails?: unknown
      result?: { value?: unknown }
    }
    if (response.exceptionDetails) throw new Error("The Desktop preload operation failed.")
    return response.result?.value
  }
  await until(async () => (await evaluate("typeof window.api?.getAccountStatus === 'function'")) || undefined, 30_000)
  await evaluate("window.api.awaitInitialization().then(() => true)")
  await until(
    async () =>
      (await evaluate("window.api.getAccountStatus().then(value => value.state)")) === "signed_out" || undefined,
    15_000,
  )
  phase = "authorize"
  await evaluate(
    "window.__authAcceptance = window.api.beginSignIn().then(value => ({ state: value.state }), () => ({ state: 'failed' })); true",
  )
  const url = await bounded(authorization.promise, 30_000)
  assert.equal(new URL(url).searchParams.get("redirect_uri"), "bharatcode://auth/callback")
  assert.equal(new URL(url).searchParams.get("code_challenge_method"), "S256")
  emit("desktop-authorize", { realPreloadIPC: true, browserLaunchCaptured: true, pkce: "S256" })
  const callback = await approveLocalFixture({ issuer, url, file, redirectUri: "bharatcode://auth/callback" })
  phase = "second-instance"
  const secondary = Bun.spawn([electron, "--disable-dev-shm-usage", "--disable-gpu", desktop, callback], {
    env,
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    assert.equal(await bounded(secondary.exited, 15_000), 0)
  } finally {
    if (secondary.exitCode === null) secondary.kill()
  }
  assert.deepEqual(await evaluate("window.__authAcceptance"), { state: "signed_in" })
  emit("desktop-signed-in", { callbackDelivery: "real-electron-second-instance", realSidecar: true })

  phase = "refresh"
  const { Auth } = await import("../../opencode/src/auth")
  const { BharatCodeAccount } = await import("../../opencode/src/bharatcode/account")
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const before = yield* auth.get(BharatCodeAccount.PROVIDER_ID)
      assert.equal(before?.type, "oauth")
      if (before?.type !== "oauth") throw new Error("Desktop did not persist OAuth credentials in the isolated store.")
      assert.equal(before.accountId, fixture.userId)
      yield* auth.set(BharatCodeAccount.PROVIDER_ID, new Auth.Oauth({ ...before, expires: 0 }))
      assert.equal(
        yield* Effect.promise(() => evaluate("window.api.refreshAccountStatus().then(value => value.state)")),
        "signed_in",
      )
      const after = yield* auth.get(BharatCodeAccount.PROVIDER_ID)
      assert.equal(after?.type, "oauth")
      if (after?.type !== "oauth") throw new Error("Desktop lost the refreshed session.")
      assert.equal(after.accountId, fixture.userId)
      assert.notEqual(after.refresh, before.refresh)
      assert.ok(after.expires > Date.now())
      emit("desktop-refreshed", { forcedExpiry: true, refreshTokenRotated: true, persisted: true })
    }).pipe(Effect.provide(Auth.defaultLayer)),
  )
  phase = "logout"
  assert.equal(await evaluate("window.api.logout().then(value => value.state)"), "signed_out")
  assert.equal(await evaluate("window.api.getAccountStatus().then(value => value.state)"), "signed_out")
  emit("desktop-complete", { localLogout: true, guiRendered: true, osProtocolHandlerTested: false })
} catch (error) {
  emit("desktop-failed", {
    phase,
    processExited: child.exitCode !== null,
    ...(phase === "startup" && error instanceof Error ? { reason: error.message } : {}),
  })
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  socket?.close()
  if (child.exitCode === null) child.kill("SIGTERM")
  await bounded(child.exited, 10_000).catch(() => child.kill("SIGKILL"))
  const logs = await Promise.all([stdout, stderr])
  // Before authorize, this fresh profile has no account credentials. Report
  // bounded startup failures only; never print post-login process/net logs.
  if (process.exitCode === 1 && phase === "startup") {
    emit("desktop-startup-diagnostic", {
      errors: logs
        .join("\n")
        .split("\n")
        .filter((line) => /Error:|Cannot find|initialization failed|sidecar exited/.test(line))
        .slice(-8),
    })
  }
  capture.stop(true)
  await fs.rm(root, { recursive: true, force: true })
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native acceptance deadline exceeded.")), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until<T>(read: () => Promise<T | undefined>, milliseconds: number): Promise<T> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    await Bun.sleep(100)
  }
  throw new Error("Native acceptance readiness deadline exceeded.")
}
