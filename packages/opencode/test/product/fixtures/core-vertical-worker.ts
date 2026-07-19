import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createBharatCodeApiFixture } from "./bharatcode-api"

const adapters = {
  cliTui: "createOpencodeClient(@opencode-ai/sdk/v2)",
  desktop: "createSdkForServer(packages/app/src/utils/server)",
  desktopAccount: "createBharatCodeAccountClient(packages/desktop/src/main/bharatcode-auth)",
} as const

type Surface = "runtime" | "cli" | "desktop"
type Adapter = (typeof adapters)[keyof typeof adapters]
type RecordedAttempt = {
  kind: "fetch" | "connect" | "spawn" | "schema" | "provider" | "authorize"
  target: string
  surface: Surface
  adapter?: Adapter
}

const project = (() => {
  const value = process.env.BHARATCODE_ACCEPTANCE_PROJECT
  if (!value) throw new Error("missing isolated acceptance project")
  return value
})()
await mkdir(project, { recursive: true })
await writeFile(join(project, "answer.txt"), "before")
await writeFile(join(project, "bharatcode.json"), JSON.stringify({ share: "disabled", formatter: false, lsp: false }))

const originalFetch = globalThis.fetch
const api = createBharatCodeApiFixture()
const attempts: RecordedAttempt[] = []
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) {
    attempts.push({ kind: "connect", target: url.origin + url.pathname, surface: "runtime" })
    return originalFetch(request)
  }
  attempts.push({ kind: "fetch", target: url.origin + url.pathname, surface: "runtime" })
  return api.fetch(request)
}) as typeof fetch

const [
  { Effect, Exit },
  { Global },
  { BharatCodeAccount },
  { ShareNext },
  { Server },
  { createOpencodeClient },
  desktopAuth,
] = await Promise.all([
  import("effect"),
  import("@opencode-ai/core/global"),
  import("@/bharatcode/account"),
  import("@/share/share-next"),
  import("@/server/server"),
  import("@opencode-ai/sdk/v2"),
  import("../../../../desktop/src/main/bharatcode-auth"),
])
const appServerModule = "../../../../app/src/utils/server"
const { createSdkForServer } = (await import(appServerModule)) as {
  createSdkForServer: (input: {
    server: { url: string; username?: string; password?: string }
    directory: string
    fetch: typeof fetch
  }) => ReturnType<typeof createOpencodeClient>
}

await Global.ensure()

const username = "bharatcode"
const password = "product-core-sidecar"
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
const cliAccount = BharatCodeAccount.defaultLayer
const cliIdentity = await Effect.runPromise(
  Effect.gen(function* () {
    const pending = yield* BharatCodeAccount.use.beginAuthorization({
      redirectUri: BharatCodeAccount.CLI_REDIRECT_URI,
    })
    attempts.push({ kind: "authorize", target: new URL(pending.url).origin, surface: "cli" })
    const state = new URL(pending.url).searchParams.get("state")
    if (!state) return yield* Effect.die(new Error("authorization state missing"))
    return yield* BharatCodeAccount.use.completeAuthorization(
      `${BharatCodeAccount.CLI_REDIRECT_URI}?code=accepted&state=${encodeURIComponent(state)}`,
    )
  }).pipe(Effect.provide(cliAccount)),
)

const start = () => Server.listen({ hostname: "127.0.0.1", port: 0, username, password })
let listener = await start()

function surfaceFetch(surface: Exclude<Surface, "runtime">, adapter: Adapter) {
  const origin = listener.url.origin
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
      const target = new URL(request.url)
      if (target.origin !== origin || target.username || target.password) {
        attempts.push({ kind: "connect", target: target.origin + target.pathname, surface, adapter })
        throw new Error(`${adapter} escaped the owned loopback listener`)
      }
      attempts.push({ kind: "connect", target: target.origin + target.pathname, surface, adapter })
      if (target.pathname === "/api/model") {
        attempts.push({ kind: "provider", target: target.pathname, surface, adapter })
      }
      return originalFetch(request, { redirect: "manual" })
    },
    { preconnect: originalFetch.preconnect },
  ) satisfies typeof fetch
}

function clients() {
  return {
    cli: createOpencodeClient({
      baseUrl: listener.url.toString(),
      directory: project,
      headers: { Authorization: authorization },
      fetch: surfaceFetch("cli", adapters.cliTui),
    }),
    desktop: createSdkForServer({
      server: { url: listener.url.toString(), username, password },
      directory: project,
      fetch: surfaceFetch("desktop", adapters.desktop),
    }),
  }
}

function desktopClient() {
  return desktopAuth.createBharatCodeAccountClient({
    getConnection: async () => ({ url: listener.url.toString(), username, password }),
    fetchImpl: surfaceFetch("desktop", adapters.desktopAccount),
  })
}

function data<T>(result: { data?: T; error?: unknown; response: Response }) {
  if (!result.response.ok || result.error || result.data === undefined) {
    throw new Error(`SDK request failed (${result.response.status})`)
  }
  return result.data
}

let receipt: Record<string, unknown> | undefined
try {
  let sdk = clients()
  const safeDesktopStatus = await desktopClient().getAccountStatus()
  const sharedAccountID = await Effect.runPromise(BharatCodeAccount.use.accountID().pipe(Effect.provide(cliAccount)))
  if (sharedAccountID !== cliIdentity.sub || safeDesktopStatus.state !== "signed_in") {
    throw new Error("CLI and Desktop did not observe the same signed-in account")
  }

  const models = data(
    await sdk.desktop.v2.model.list({
      location: { directory: project },
    }),
  )
  if (!Array.isArray(models) || models.length !== 1 || models[0]?.providerID !== "bharatcode") {
    throw new Error("shipped catalog did not expose exactly one BharatCode provider model")
  }

  const session = data(
    await sdk.cli.session.create({
      title: "Product Core shared session",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    }),
  )
  const prompt = data(
    await sdk.desktop.session.prompt({
      sessionID: session.id,
      model: { providerID: "bharatcode", modelID: "bharatcode-coder" },
      agent: "build",
      parts: [{ type: "text", text: "Replace before with after in answer.txt." }],
    }),
  )
  if (!prompt.parts?.some((part) => part.type === "text" && /completed/.test(part.text ?? ""))) {
    throw new Error("streamed assistant text was not observed")
  }
  const edited = (await readFile(join(project, "answer.txt"), "utf8")) === "after"
  if (!edited) throw new Error("edit tool did not apply")

  const command = "printf shell-ok > command.txt"
  attempts.push({ kind: "spawn", target: command, surface: "cli", adapter: adapters.cliTui })
  data(await sdk.cli.session.shell({ sessionID: session.id, agent: "build", command }))
  const commandRan = (await readFile(join(project, "command.txt"), "utf8")) === "shell-ok"
  if (!commandRan) throw new Error("shell command did not run")

  const beforeRestart = data(await sdk.desktop.session.messages({ sessionID: session.id }))
  await listener.stop(true)
  listener = await start()
  sdk = clients()
  const afterRestart = data(await sdk.cli.session.messages({ sessionID: session.id }))
  if (afterRestart.length !== beforeRestart.length) throw new Error("session continuity failed across sidecar restart")

  attempts.push({ kind: "schema", target: join(project, "bharatcode.json"), surface: "runtime" })
  const beforeShare = attempts.length
  const shareExit = await Effect.runPromiseExit(ShareNext.use.url().pipe(Effect.provide(ShareNext.defaultLayer)))
  if (Exit.isSuccess(shareExit) || attempts.length !== beforeShare) {
    throw new Error("ShareNext resolved a target while disabled")
  }

  const signedOut = await desktopClient().logout()
  const cliAfterLogout = await Effect.runPromise(BharatCodeAccount.use.accountID().pipe(Effect.provide(cliAccount)))
  if (signedOut.state !== "signed_out" || cliAfterLogout !== undefined) {
    throw new Error("shared logout did not clear account")
  }

  const allowedExternal = new Set(["https://bharatcode.ai", "https://evgvlcaxfpwupaiwzqqm.supabase.co"])
  const forbiddenAttempts = attempts.filter((attempt) => {
    if (attempt.kind === "fetch" || attempt.kind === "authorize") {
      return !allowedExternal.has(new URL(attempt.target).origin)
    }
    if (attempt.kind === "connect") return !/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(attempt.target)
    if (attempt.kind === "spawn") return attempt.target !== command
    if (attempt.kind === "provider") return attempt.target !== "/api/model"
    return attempt.target !== join(project, "bharatcode.json")
  })
  receipt = {
    adapters,
    identity: { cli: cliIdentity.sub, desktop: sharedAccountID },
    project,
    sessionID: session.id,
    chatCalls: api.chatCalls,
    messageCount: afterRestart.length,
    attempts,
    forbiddenAttempts,
    shareAttempts: attempts.filter((attempt) => /share/i.test(attempt.target)),
    checks: {
      sharedIdentity: cliIdentity.sub === sharedAccountID,
      liveCatalog: models.length === 1,
      streamedTextAndTool: api.chatCalls >= 2,
      editApplied: edited,
      commandRan,
      restartContinuity: afterRestart.length === beforeRestart.length,
      accountLifecycle: signedOut.state === "signed_out" && cliAfterLogout === undefined,
      boundaryClosed: forbiddenAttempts.length === 0 && attempts.every((attempt) => !/share/i.test(attempt.target)),
    },
  }
} finally {
  await listener.stop(true)
  globalThis.fetch = originalFetch
}

if (!receipt) throw new Error("vertical receipt was not produced")
console.log(JSON.stringify(receipt))
