import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const BHARATCODE_OAUTH = {
  issuer: "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1",
  nativeClientId: "4cad332a-232f-4ef2-9363-12fea4420635",
  desktopRedirectUri: "bharatcode://auth/callback",
  loopbackRedirectUri: "http://127.0.0.1:27182/callback",
  vscodeRedirectUri: "vscode://bharatcode.bharatcode/auth/callback",
  modelProxy: "https://bharatcode.ai/api/model/v1",
  scope: "openid email profile",
}

export type BharatCodeAuthState = {
  authenticated: boolean
  configured: boolean
  credentialsPath: string
  configPath: string
}

export type BharatCodeAccountState = "signed_out" | "signed_in" | "needs_sign_in" | "connection_issue"

export type BharatCodeConnectionStatus = {
  ok: boolean
  endpoint: string
  kind?: "auth" | "http" | "network" | "service" | "unknown"
  status?: number
  message?: string
}

export type BharatCodeAccountStatus = BharatCodeAuthState & {
  state: BharatCodeAccountState
  checkedAt: string
  email?: string
  expiresAt?: number
  message?: string
  connection?: BharatCodeConnectionStatus
}

type BharatCodeCredentials = {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_at?: number
  id_token?: string
  user?: unknown
}

type FetchImpl = typeof fetch
type ReauthorizeBharatCode = (error: unknown) => Promise<BharatCodeCredentials | null | undefined>

export type BharatCodeSignInOptions = {
  forceAccountSelection?: boolean
  onBrowserUrl?: (url: string) => void
}

type SignInOptions = BharatCodeSignInOptions & {
  openExternal?: (url: string) => Promise<void> | void
  fetchImpl?: FetchImpl
  home?: string
  timeoutMs?: number
  pluginSpec?: string
}

type AccountStatusOptions = {
  home?: string
  fetchImpl?: FetchImpl
  refresh?: boolean
  checkConnection?: boolean
}

type PendingSignIn = {
  state: string
  codeVerifier: string
  redirectUri: string
  fetchImpl: FetchImpl
  home: string
  pluginSpec?: string
  timer: ReturnType<typeof setTimeout>
  loopbackServer?: Server
  resolve: (state: BharatCodeAuthState) => void
  reject: (error: unknown) => void
}

const TOKEN_REFRESH_SKEW_SECONDS = 300
const DEFAULT_SIGN_IN_TIMEOUT_MS = 180_000
const DEFAULT_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  plugin: ["bharatcode"],
}

let pendingSignIn: PendingSignIn | null = null

export function buildBharatCodeSignInUrl({
  state,
  codeChallenge,
  redirectUri = BHARATCODE_OAUTH.desktopRedirectUri,
  forceAccountSelection = false,
}: {
  state: string
  codeChallenge: string
  redirectUri?: string
  forceAccountSelection?: boolean
}) {
  const url = new URL(`${BHARATCODE_OAUTH.issuer}/oauth/authorize`)
  url.searchParams.set("client_id", BHARATCODE_OAUTH.nativeClientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", BHARATCODE_OAUTH.scope)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  if (forceAccountSelection) url.searchParams.set("prompt", "select_account")
  return url
}

export function isBharatCodeAuthCallback(input: string) {
  try {
    const url = new URL(input)
    if (url.protocol === "bharatcode:" && url.hostname === "auth" && url.pathname === "/callback") return true
    return (
      url.protocol === "http:" &&
      url.pathname === "/callback" &&
      url.port === "27182" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    )
  } catch {
    return false
  }
}

export function bharatCodeCredentialsPath(home = process.env.BHARATCODE_HOME || homedir()) {
  return join(home, ".bharatcode", "credentials.json")
}

export function opencodeConfigPath(home = process.env.BHARATCODE_HOME || homedir()) {
  return join(home, ".config", "opencode", "opencode.jsonc")
}

export function resolveBundledBharatCodePluginPath(resourcesPath: string) {
  return join(resourcesPath, "provider", "bharatcode", "index.js")
}

export function resolveDesktopResourcesPath({
  packaged,
  processResourcesPath,
  mainBundleDir,
}: {
  packaged: boolean
  processResourcesPath: string
  mainBundleDir: string
}) {
  if (packaged) return processResourcesPath
  return resolve(mainBundleDir, "..", "..", "resources")
}

export function base64Url(input: Buffer | Uint8Array | string) {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function randomVerifier() {
  return base64Url(randomBytes(32))
}

export function codeChallenge(verifier: string) {
  return base64Url(createHash("sha256").update(verifier).digest())
}

export function randomState() {
  return base64Url(randomBytes(24))
}

export function shouldRefreshToken(
  credentials: BharatCodeCredentials | null,
  { now = Math.floor(Date.now() / 1000) } = {},
) {
  if (!credentials?.access_token || !credentials?.expires_at) return true
  return credentials.expires_at - now <= TOKEN_REFRESH_SKEW_SECONDS
}

export async function readBharatCodeCredentials(
  home = process.env.BHARATCODE_HOME || homedir(),
): Promise<BharatCodeCredentials | null> {
  try {
    return JSON.parse(await readFile(bharatCodeCredentialsPath(home), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null
    throw error
  }
}

async function saveBharatCodeCredentials(
  credentials: BharatCodeCredentials,
  home = process.env.BHARATCODE_HOME || homedir(),
) {
  const path = bharatCodeCredentialsPath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function normalizeTokenResponse(
  tokenResponse: Record<string, any>,
  previousCredentials: BharatCodeCredentials | null = null,
) {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || previousCredentials?.refresh_token,
    token_type: tokenResponse.token_type || "bearer",
    expires_at: now + Number(tokenResponse.expires_in || 3600),
    id_token: tokenResponse.id_token || previousCredentials?.id_token,
    user: tokenResponse.user || previousCredentials?.user,
  }
}

async function postTokenForm(params: Record<string, string>, { fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {}) {
  const response = await fetchImpl(new URL(`${BHARATCODE_OAUTH.issuer}/oauth/token`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body.error_description || body.error || `OAuth token request failed (${response.status})`
    throw new Error(message)
  }
  return body
}

export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  redirectUri = BHARATCODE_OAUTH.desktopRedirectUri,
  clientId = BHARATCODE_OAUTH.nativeClientId,
  fetchImpl = fetch,
}: {
  code: string
  codeVerifier: string
  redirectUri?: string
  clientId?: string
  fetchImpl?: FetchImpl
}) {
  const tokenResponse = await postTokenForm(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    },
    { fetchImpl },
  )
  return normalizeTokenResponse(tokenResponse)
}

export async function refreshBharatCodeCredentials(
  credentials: BharatCodeCredentials,
  { clientId = BHARATCODE_OAUTH.nativeClientId, fetchImpl = fetch }: { clientId?: string; fetchImpl?: FetchImpl } = {},
) {
  if (!credentials?.refresh_token) {
    throw new Error("No BharatCode refresh token found. Sign in to BharatCode again.")
  }
  const tokenResponse = await postTokenForm(
    {
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: clientId,
    },
    { fetchImpl },
  )
  return normalizeTokenResponse(tokenResponse, credentials)
}

export async function getBharatCodeAccessToken({
  home = process.env.BHARATCODE_HOME || homedir(),
  fetchImpl = fetch,
  reauthorize,
}: {
  home?: string
  fetchImpl?: FetchImpl
  reauthorize?: ReauthorizeBharatCode
} = {}) {
  let credentials = await readBharatCodeCredentials(home)
  if (!credentials || (!credentials.access_token && !credentials.refresh_token)) {
    if (!reauthorize) throw new Error("No BharatCode credentials found. Sign in to BharatCode first.")
    credentials = (await reauthorize(new Error("No BharatCode credentials found."))) ?? null
    if (credentials) await saveBharatCodeCredentials(credentials, home)
  }

  if (!credentials) throw new Error("No BharatCode credentials found. Sign in to BharatCode first.")

  if (shouldRefreshToken(credentials)) {
    try {
      credentials = await refreshBharatCodeCredentials(credentials, { fetchImpl })
      await saveBharatCodeCredentials(credentials, home)
    } catch (error) {
      if (!reauthorize) throw error
      credentials = (await reauthorize(error)) ?? null
      if (credentials) await saveBharatCodeCredentials(credentials, home)
    }
  }

  if (!credentials?.access_token) {
    throw new Error("No BharatCode access token found. Sign in to BharatCode again.")
  }

  return credentials.access_token
}

export async function fetchBharatCodeUserInfo(
  accessToken: string,
  { fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {},
) {
  const response = await fetchImpl(new URL(`${BHARATCODE_OAUTH.issuer}/oauth/userinfo`), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body.error_description || body.error || `Userinfo request failed (${response.status})`)
  }
  return body
}

export async function getBharatCodeAuthState(
  home = process.env.BHARATCODE_HOME || homedir(),
): Promise<BharatCodeAuthState> {
  const credentialsPath = bharatCodeCredentialsPath(home)
  const configPath = opencodeConfigPath(home)
  const credentials = await readBharatCodeCredentials(home).catch(() => null)
  return {
    authenticated: Boolean(credentials?.access_token || credentials?.refresh_token),
    configured: await hasBharatCodePlugin(configPath),
    credentialsPath,
    configPath,
  }
}

function emailFromCredentials(credentials: BharatCodeCredentials | null) {
  const user = credentials?.user
  if (!user || typeof user !== "object") return
  const email = (user as { email?: unknown }).email
  return typeof email === "string" && email ? email : undefined
}

function safeErrorMessage(error: unknown) {
  const message =
    error instanceof Error && error.message ? error.message : typeof error === "string" ? error : "Unknown error"
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:access|refresh|id)_token=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500)
}

function connectionErrorKind(error: unknown): NonNullable<BharatCodeConnectionStatus["kind"]> {
  const message = safeErrorMessage(error)
  if (/network|fetch|econnreset|econnrefused|enotfound|timedout|timeout|dns|getaddrinfo/i.test(message)) {
    return "network"
  }
  return "unknown"
}

function statusBase({
  home,
  configured,
}: {
  home: string
  configured: boolean
}): Omit<BharatCodeAccountStatus, "state" | "authenticated"> {
  return {
    configured,
    credentialsPath: bharatCodeCredentialsPath(home),
    configPath: opencodeConfigPath(home),
    checkedAt: new Date().toISOString(),
  }
}

async function checkBharatCodeModelProxy(accessToken: string, fetchImpl: FetchImpl) {
  const endpoint = new URL("models", `${BHARATCODE_OAUTH.modelProxy}/`).toString()
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (response.ok) {
      return {
        ok: true,
        endpoint,
        status: response.status,
      } satisfies BharatCodeConnectionStatus
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        endpoint,
        kind: "auth",
        status: response.status,
        message: "BharatCode sign-in needs to be refreshed.",
      } satisfies BharatCodeConnectionStatus
    }
    return {
      ok: false,
      endpoint,
      kind: response.status >= 500 ? "service" : "http",
      status: response.status,
      message:
        response.status >= 500
          ? "BharatCode is reachable, but the model service is unavailable right now."
          : `BharatCode model proxy returned ${response.status}.`,
    } satisfies BharatCodeConnectionStatus
  } catch (error) {
    return {
      ok: false,
      endpoint,
      kind: connectionErrorKind(error),
      message: "Desktop could not reach BharatCode. Check your internet connection, VPN, proxy, or firewall.",
    } satisfies BharatCodeConnectionStatus
  }
}

export async function getBharatCodeAccountStatus({
  home = process.env.BHARATCODE_HOME || homedir(),
  fetchImpl = fetch,
  refresh = false,
  checkConnection = false,
}: AccountStatusOptions = {}): Promise<BharatCodeAccountStatus> {
  const configured = await hasBharatCodePlugin(opencodeConfigPath(home))
  const base = statusBase({ home, configured })
  let credentials = await readBharatCodeCredentials(home).catch(() => null)

  if (!credentials || (!credentials.access_token && !credentials.refresh_token)) {
    return {
      ...base,
      state: "signed_out",
      authenticated: false,
      message: "Sign in to BharatCode to use Desktop.",
    }
  }

  let activeCredentials = credentials
  let accessToken = activeCredentials.access_token
  if (refresh || shouldRefreshToken(activeCredentials)) {
    try {
      accessToken = await getBharatCodeAccessToken({ home, fetchImpl })
      activeCredentials = (await readBharatCodeCredentials(home).catch(() => activeCredentials)) ?? activeCredentials
    } catch (error) {
      return {
        ...base,
        state: "needs_sign_in",
        authenticated: true,
        email: emailFromCredentials(activeCredentials),
        expiresAt: activeCredentials.expires_at,
        message: "Sign in again to refresh BharatCode on this device.",
        connection: {
          ok: false,
          endpoint: `${BHARATCODE_OAUTH.issuer}/oauth/token`,
          kind: "auth",
          message: safeErrorMessage(error),
        },
      }
    }
  }

  if (!accessToken) {
    return {
      ...base,
      state: "needs_sign_in",
      authenticated: true,
      email: emailFromCredentials(activeCredentials),
      expiresAt: activeCredentials.expires_at,
      message: "Sign in again to refresh BharatCode on this device.",
    }
  }

  let email = emailFromCredentials(activeCredentials)
  if (!email) {
    try {
      const user = await fetchBharatCodeUserInfo(accessToken, { fetchImpl })
      email = typeof user?.email === "string" ? user.email : undefined
    } catch {}
  }

  const connection = checkConnection ? await checkBharatCodeModelProxy(accessToken, fetchImpl) : undefined
  const state: BharatCodeAccountState =
    connection?.ok === false ? (connection.kind === "auth" ? "needs_sign_in" : "connection_issue") : "signed_in"

  return {
    ...base,
    state,
    authenticated: true,
    email,
    expiresAt: activeCredentials.expires_at,
    ...(connection && { connection }),
    ...(state === "needs_sign_in" && { message: "Sign in again to refresh BharatCode on this device." }),
    ...(state === "connection_issue" && {
      message: connection?.message ?? "Desktop could not reach BharatCode.",
    }),
  }
}

export async function signInToBharatCode({
  openExternal,
  fetchImpl = fetch,
  home = process.env.BHARATCODE_HOME || homedir(),
  timeoutMs = DEFAULT_SIGN_IN_TIMEOUT_MS,
  pluginSpec,
  forceAccountSelection = false,
  onBrowserUrl,
}: SignInOptions = {}) {
  if (!openExternal) throw new Error("BharatCode sign-in requires an external browser opener.")
  if (pendingSignIn) throw new Error("BharatCode sign-in is already in progress.")

  const codeVerifier = randomVerifier()
  const state = randomState()
  const redirectUri = BHARATCODE_OAUTH.loopbackRedirectUri
  const loopbackServer = await startLoopbackCallbackServer(redirectUri)
  const authorizationUrl = buildBharatCodeSignInUrl({
    state,
    redirectUri,
    codeChallenge: codeChallenge(codeVerifier),
    forceAccountSelection,
  })

  const completion = new Promise<BharatCodeAuthState>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingSignIn || pendingSignIn.state !== state) return
      const pending = pendingSignIn
      pendingSignIn = null
      closeLoopbackServer(pending.loopbackServer)
      pending.reject(new Error("Timed out waiting for BharatCode OAuth callback."))
    }, timeoutMs)
    pendingSignIn = {
      state,
      codeVerifier,
      redirectUri,
      fetchImpl,
      home,
      pluginSpec,
      timer,
      loopbackServer,
      resolve,
      reject,
    }
  })

  const authorizationUrlString = authorizationUrl.toString()
  try {
    onBrowserUrl?.(authorizationUrlString)
  } catch {}

  try {
    await openExternal(authorizationUrlString)
  } catch (error) {
    failPendingSignIn(error)
  }

  return completion
}

function startLoopbackCallbackServer(redirectUri: string) {
  const redirect = new URL(redirectUri)
  const port = Number(redirect.port)
  return new Promise<Server>((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", redirect)
      const callbackUrl = `${redirect.origin}${requestUrl.pathname}${requestUrl.search}`
      void handleBharatCodeAuthCallback(callbackUrl)
        .then((handled) => {
          response.statusCode = handled ? 200 : 404
          response.setHeader("content-type", "text/html; charset=utf-8")
          response.end(
            handled
              ? "<!doctype html><title>BharatCode sign-in complete</title><p>BharatCode sign-in complete. You can close this tab.</p>"
              : "<!doctype html><title>BharatCode sign-in failed</title><p>This BharatCode sign-in callback was not recognized.</p>",
          )
        })
        .catch((error) => {
          response.statusCode = 500
          response.setHeader("content-type", "text/html; charset=utf-8")
          response.end(
            `<!doctype html><title>BharatCode sign-in failed</title><p>${escapeHtml(
              error instanceof Error ? error.message : String(error),
            )}</p>`,
          )
        })
    })

    const onError = (error: NodeJS.ErrnoException) => {
      server.close()
      if (error.code === "EADDRINUSE") {
        reject(new Error(`OAuth callback port ${port} is already in use. Close the other process and try again.`))
        return
      }
      reject(error)
    }

    server.once("error", onError)
    server.listen(port, redirect.hostname, () => {
      server.off("error", onError)
      resolve(server)
    })
  })
}

export async function handleBharatCodeAuthCallback(input: string) {
  if (!isBharatCodeAuthCallback(input)) return false
  const pending = pendingSignIn
  if (!pending) return false

  const url = new URL(input)
  const error = url.searchParams.get("error")
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  if (error) {
    failPendingSignIn(new Error(`Authorization failed: ${error}`))
    return true
  }
  if (!code || state !== pending.state) {
    failPendingSignIn(new Error("OAuth callback state mismatch."))
    return true
  }

  try {
    let credentials = await exchangeAuthorizationCode({
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      fetchImpl: pending.fetchImpl,
    })
    try {
      credentials = {
        ...credentials,
        user: await fetchBharatCodeUserInfo(credentials.access_token!, { fetchImpl: pending.fetchImpl }),
      }
    } catch {
      credentials = { ...credentials, user: null }
    }
    await saveBharatCodeCredentials(credentials, pending.home)
    await ensureBharatCodePlugin({ configPath: opencodeConfigPath(pending.home), pluginSpec: pending.pluginSpec })
    completePendingSignIn(await getBharatCodeAuthState(pending.home))
  } catch (callbackError) {
    failPendingSignIn(callbackError)
  }

  return true
}

function completePendingSignIn(state: BharatCodeAuthState) {
  const pending = pendingSignIn
  if (!pending) return
  pendingSignIn = null
  clearTimeout(pending.timer)
  closeLoopbackServer(pending.loopbackServer)
  pending.resolve(state)
}

function failPendingSignIn(error: unknown) {
  const pending = pendingSignIn
  if (!pending) return
  pendingSignIn = null
  clearTimeout(pending.timer)
  closeLoopbackServer(pending.loopbackServer)
  pending.reject(error)
}

function closeLoopbackServer(server: Server | undefined) {
  if (!server) return
  if (!server.listening) return
  server.close()
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function stripJsonComments(input: string) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1")
}

function formatConfig(config: unknown) {
  return `${JSON.stringify(config, null, 2)}\n`
}

function defaultConfig(pluginSpec: string) {
  return {
    ...DEFAULT_CONFIG,
    plugin: [pluginSpec],
  }
}

function pluginSpecifier(value: unknown) {
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
}

function isBharatCodePluginSpec(value: unknown) {
  const spec = pluginSpecifier(value)
  if (!spec) return false
  if (spec === "bharatcode") return true
  return spec.replace(/\\/g, "/").endsWith("/provider/bharatcode/index.js")
}

function replacePluginSpec(value: unknown, pluginSpec: string) {
  if (Array.isArray(value)) return [pluginSpec, value[1]]
  return pluginSpec
}

function patchPluginList(plugins: unknown[], pluginSpec: string) {
  let replaced = false
  const next: unknown[] = []
  for (const plugin of plugins) {
    if (!isBharatCodePluginSpec(plugin)) {
      next.push(plugin)
      continue
    }
    if (replaced) continue
    next.push(replacePluginSpec(plugin, pluginSpec))
    replaced = true
  }
  if (!replaced) next.push(pluginSpec)
  return next
}

function patchJsonConfig(raw: string, pluginSpec: string) {
  const config = JSON.parse(stripJsonComments(raw || "{}"))
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  config.plugin = patchPluginList(plugins, pluginSpec)
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  const content = formatConfig(config)
  return { changed: content !== raw, content }
}

function patchJsoncFallback(raw: string, pluginSpec: string) {
  const encodedPlugin = JSON.stringify(pluginSpec)
  const pluginArray = /("plugin"\s*:\s*\[)([\s\S]*?)(\])/m
  const match = raw.match(pluginArray)
  if (match) {
    if (/"bharatcode"/.test(match[2])) {
      return {
        changed: true,
        content: raw.replace(pluginArray, `$1${encodedPlugin}$3`),
      }
    }
    const existing = match[2].trim()
    const separator = existing ? ", " : ""
    return {
      changed: true,
      content: raw.replace(pluginArray, `$1${existing}${separator}${encodedPlugin}$3`),
    }
  }

  const objectStart = raw.indexOf("{")
  if (objectStart >= 0) {
    const insertAt = objectStart + 1
    return {
      changed: true,
      content: `${raw.slice(0, insertAt)}\n  "plugin": [${encodedPlugin}],${raw.slice(insertAt)}`,
    }
  }

  return { changed: true, content: formatConfig(defaultConfig(pluginSpec)) }
}

export async function ensureBharatCodePlugin({
  configPath = opencodeConfigPath(),
  pluginSpec = "bharatcode",
}: {
  configPath?: string
  pluginSpec?: string
} = {}) {
  await mkdir(dirname(configPath), { recursive: true })
  let raw = ""
  try {
    raw = await readFile(configPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
    await writeFile(configPath, formatConfig(defaultConfig(pluginSpec)), { mode: 0o600 })
    return { changed: true, configPath }
  }

  const patch = (() => {
    try {
      return patchJsonConfig(raw, pluginSpec)
    } catch {
      return patchJsoncFallback(raw, pluginSpec)
    }
  })()

  if (patch.changed) await writeFile(configPath, patch.content, { mode: 0o600 })
  return { changed: patch.changed, configPath }
}

async function hasBharatCodePlugin(path: string) {
  try {
    const raw = await readFile(path, "utf8")
    try {
      const config = JSON.parse(stripJsonComments(raw || "{}"))
      return Array.isArray(config.plugin) && config.plugin.some(isBharatCodePluginSpec)
    } catch {
      return /["']bharatcode["']|provider[\/\\]bharatcode[\/\\]index\.js/.test(raw)
    }
  } catch {
    return false
  }
}
