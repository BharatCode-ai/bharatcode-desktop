import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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

type BharatCodeCredentials = {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_at?: number
  id_token?: string
  user?: unknown
}

type FetchImpl = typeof fetch

type SignInOptions = {
  openExternal?: (url: string) => Promise<void> | void
  fetchImpl?: FetchImpl
  home?: string
  timeoutMs?: number
}

type PendingSignIn = {
  state: string
  codeVerifier: string
  redirectUri: string
  fetchImpl: FetchImpl
  home: string
  timer: ReturnType<typeof setTimeout>
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
}: {
  state: string
  codeChallenge: string
  redirectUri?: string
}) {
  const url = new URL(`${BHARATCODE_OAUTH.issuer}/oauth/authorize`)
  url.searchParams.set("client_id", BHARATCODE_OAUTH.nativeClientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", BHARATCODE_OAUTH.scope)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url
}

export function isBharatCodeAuthCallback(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === "bharatcode:" && url.hostname === "auth" && url.pathname === "/callback"
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

export function shouldRefreshToken(credentials: BharatCodeCredentials | null, { now = Math.floor(Date.now() / 1000) } = {}) {
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

function normalizeTokenResponse(tokenResponse: Record<string, any>, previousCredentials: BharatCodeCredentials | null = null) {
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

export async function fetchBharatCodeUserInfo(accessToken: string, { fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {}) {
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

export async function signInToBharatCode({
  openExternal,
  fetchImpl = fetch,
  home = process.env.BHARATCODE_HOME || homedir(),
  timeoutMs = DEFAULT_SIGN_IN_TIMEOUT_MS,
}: SignInOptions = {}) {
  if (!openExternal) throw new Error("BharatCode sign-in requires an external browser opener.")
  if (pendingSignIn) throw new Error("BharatCode sign-in is already in progress.")

  const codeVerifier = randomVerifier()
  const state = randomState()
  const redirectUri = BHARATCODE_OAUTH.desktopRedirectUri
  const authorizationUrl = buildBharatCodeSignInUrl({
    state,
    redirectUri,
    codeChallenge: codeChallenge(codeVerifier),
  })

  const completion = new Promise<BharatCodeAuthState>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingSignIn || pendingSignIn.state !== state) return
      const pending = pendingSignIn
      pendingSignIn = null
      pending.reject(new Error("Timed out waiting for BharatCode OAuth callback."))
    }, timeoutMs)
    pendingSignIn = {
      state,
      codeVerifier,
      redirectUri,
      fetchImpl,
      home,
      timer,
      resolve,
      reject,
    }
  })

  try {
    await openExternal(authorizationUrl.toString())
  } catch (error) {
    failPendingSignIn(error)
  }

  return completion
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
    await ensureBharatCodePlugin({ configPath: opencodeConfigPath(pending.home) })
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
  pending.resolve(state)
}

function failPendingSignIn(error: unknown) {
  const pending = pendingSignIn
  if (!pending) return
  pendingSignIn = null
  clearTimeout(pending.timer)
  pending.reject(error)
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

function patchJsonConfig(raw: string) {
  const config = JSON.parse(stripJsonComments(raw || "{}"))
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  if (plugins.includes("bharatcode")) return { changed: false, content: raw }
  config.plugin = [...plugins, "bharatcode"]
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  return { changed: true, content: formatConfig(config) }
}

function patchJsoncFallback(raw: string) {
  const pluginArray = /("plugin"\s*:\s*\[)([\s\S]*?)(\])/m
  const match = raw.match(pluginArray)
  if (match) {
    if (/"bharatcode"/.test(match[2])) return { changed: false, content: raw }
    const existing = match[2].trim()
    const separator = existing ? ", " : ""
    return {
      changed: true,
      content: raw.replace(pluginArray, `$1${existing}${separator}"bharatcode"$3`),
    }
  }

  const objectStart = raw.indexOf("{")
  if (objectStart >= 0) {
    const insertAt = objectStart + 1
    return {
      changed: true,
      content: `${raw.slice(0, insertAt)}\n  "plugin": ["bharatcode"],${raw.slice(insertAt)}`,
    }
  }

  return { changed: true, content: formatConfig(DEFAULT_CONFIG) }
}

export async function ensureBharatCodePlugin({ configPath = opencodeConfigPath() }: { configPath?: string } = {}) {
  await mkdir(dirname(configPath), { recursive: true })
  let raw = ""
  try {
    raw = await readFile(configPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
    await writeFile(configPath, formatConfig(DEFAULT_CONFIG), { mode: 0o600 })
    return { changed: true, configPath }
  }

  const patch = (() => {
    try {
      return patchJsonConfig(raw)
    } catch {
      return patchJsoncFallback(raw)
    }
  })()

  if (patch.changed) await writeFile(configPath, patch.content, { mode: 0o600 })
  return { changed: patch.changed, configPath }
}

async function hasBharatCodePlugin(path: string) {
  try {
    return /["']bharatcode["']/.test(await readFile(path, "utf8"))
  } catch {
    return false
  }
}
