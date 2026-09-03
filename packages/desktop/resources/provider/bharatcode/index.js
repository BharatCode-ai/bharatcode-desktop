import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"

const PROVIDER_ID = "bharatcode"
const MODEL_ID = "bharatcode:qwen36-35b-awq-200k"
const MODEL = `${PROVIDER_ID}/${MODEL_ID}`
const DEFAULT_BASE_URL = "https://bharatcode.ai/api/model/v1"
const SUPABASE_URL = process.env.BHARATCODE_SUPABASE_URL || "https://evgvlcaxfpwupaiwzqqm.supabase.co"
const NATIVE_CLIENT_ID = process.env.BHARATCODE_NATIVE_CLIENT_ID || "4cad332a-232f-4ef2-9363-12fea4420635"
const REDIRECT_URI = process.env.BHARATCODE_REDIRECT_URI || "http://127.0.0.1:27182/callback"
const OAUTH_SCOPE = process.env.BHARATCODE_OAUTH_SCOPE || "openid email profile"
const TOKEN_REFRESH_SKEW_SECONDS = 300

const MODEL_CAPABILITIES = {
  reasoning: true,
  temperature: true,
  tool_call: true,
  attachment: true,
  modalities: {
    input: ["text", "image"],
    output: ["text"],
  },
}

let interactiveLoginPromise

function configuredModel(value) {
  const model = value === undefined ? MODEL : value
  if (model === MODEL) return model
  throw new Error(`BharatCode supports only ${MODEL}. Retired model IDs are not translated.`)
}

function validateExistingConfigModels(config) {
  for (const field of ["model", "small_model"]) {
    const model = config?.[field]
    if (typeof model !== "string") continue
    if (model === MODEL || model === MODEL_ID) continue
    if (model.startsWith(`${PROVIDER_ID}/`) || model.startsWith(`${PROVIDER_ID}:`)) configuredModel(model)
  }
}

function homeDir(options = {}) {
  return options.credentialsHome || options.home || process.env.BHARATCODE_HOME || os.homedir()
}

function credentialsPath(options = {}) {
  if (options.credentialsPath) return options.credentialsPath
  if (process.env.BHARATCODE_CREDENTIALS_PATH) return process.env.BHARATCODE_CREDENTIALS_PATH
  return path.join(homeDir(options), ".bharatcode", "credentials.json")
}

function base64Url(input) {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function randomVerifier() {
  return base64Url(crypto.randomBytes(32))
}

function codeChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest())
}

function randomState() {
  return base64Url(crypto.randomBytes(24))
}

function buildAuthorizationUrl({ state, challenge, redirectUri = REDIRECT_URI }) {
  const url = new URL("/auth/v1/oauth/authorize", SUPABASE_URL)
  url.searchParams.set("client_id", NATIVE_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", OAUTH_SCOPE)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url
}

async function readCredentials(options = {}) {
  try {
    return JSON.parse(await readFile(credentialsPath(options), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function saveCredentials(credentials, options = {}) {
  const file = credentialsPath(options)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
}

function shouldRefreshToken(credentials, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!credentials?.access_token || !credentials?.expires_at) return true
  return credentials.expires_at - now <= TOKEN_REFRESH_SKEW_SECONDS
}

function normalizeTokenResponse(tokenResponse, previousCredentials = null) {
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

async function postTokenForm(params, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(new URL("/auth/v1/oauth/token", SUPABASE_URL), {
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

async function exchangeAuthorizationCode({ code, codeVerifier, redirectUri = REDIRECT_URI, fetchImpl = fetch } = {}) {
  const tokenResponse = await postTokenForm(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: NATIVE_CLIENT_ID,
      code_verifier: codeVerifier,
    },
    { fetchImpl },
  )
  return normalizeTokenResponse(tokenResponse)
}

async function refreshCredentials(credentials, { fetchImpl = fetch } = {}) {
  if (!credentials?.refresh_token) throw new Error("No BharatCode refresh token found.")
  const tokenResponse = await postTokenForm(
    {
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: NATIVE_CLIENT_ID,
    },
    { fetchImpl },
  )
  return normalizeTokenResponse(tokenResponse, credentials)
}

async function fetchUserInfo(accessToken, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(new URL("/auth/v1/oauth/userinfo", SUPABASE_URL), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(body.error_description || body.error || `Userinfo request failed (${response.status})`)
  return body
}

function browserOpenCommand(url, platform = process.platform) {
  const commands = {
    win32: { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] },
    darwin: { command: "open", args: [url] },
    linux: { command: "xdg-open", args: [url] },
  }
  return commands[platform] || commands.linux
}

function openBrowser(url) {
  const { command, args } = browserOpenCommand(url)
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.unref()
}

function callbackHtml(status, message) {
  return `<!doctype html><title>BharatCode Auth</title><body style="font:16px/1.5 system-ui;background:#0a0a0a;color:#eee"><main style="max-width:560px;margin:20vh auto;padding:32px;border:1px solid #333"><strong>${status}</strong><p>${message}</p></main></body>`
}

function createCallbackListener({ expectedState, redirectUri, timeoutMs = 180000 }) {
  const redirect = new URL(redirectUri)
  const host = redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname
  const port = Number(redirect.port || 80)
  const pathname = redirect.pathname

  let timer = null
  let settled = false
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", redirectUri)
    if (requestUrl.pathname !== pathname) {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("Not found")
      return
    }

    const state = requestUrl.searchParams.get("state")
    const code = requestUrl.searchParams.get("code")
    const error = requestUrl.searchParams.get("error")
    if (error) {
      response.writeHead(400, { "content-type": "text/html" })
      response.end(callbackHtml("error", `Authorization failed: ${error}`))
      settle(new Error(`Authorization failed: ${error}`))
      return
    }
    if (!code || state !== expectedState) {
      response.writeHead(400, { "content-type": "text/html" })
      response.end(callbackHtml("error", "Authorization state did not match. Return to BharatCode and try again."))
      settle(new Error("OAuth callback state mismatch."))
      return
    }

    response.writeHead(200, { "content-type": "text/html" })
    response.end(callbackHtml("ok", "BharatCode is authenticated. You can close this tab and return to BharatCode."))
    settle(null, code)
  })

  let settle = () => {}
  const code = new Promise((resolve, reject) => {
    settle = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
  })

  const listening = new Promise((resolve, reject) => {
    function onListenError(error) {
      cleanup()
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`OAuth callback port ${port} is already in use. Close the other process and try again.`))
        return
      }
      reject(error)
    }
    function onListening() {
      server.off("error", onListenError)
      server.on("error", settle)
      timer = setTimeout(() => settle(new Error("Timed out waiting for OAuth callback.")), timeoutMs)
      resolve()
    }
    server.once("error", onListenError)
    server.once("listening", onListening)
    server.listen(port, host)
  })

  function cleanup() {
    if (timer) clearTimeout(timer)
    if (server.listening) server.close()
  }

  return { listening, code, close: cleanup }
}

async function loginWithBrowser(options = {}) {
  const { redirectUri = REDIRECT_URI, open = openBrowser, fetchImpl = fetch, timeoutMs } = options
  const verifier = randomVerifier()
  const state = randomState()
  const authorizationUrl = buildAuthorizationUrl({
    state,
    challenge: codeChallenge(verifier),
    redirectUri,
  })

  const callback = createCallbackListener({ expectedState: state, redirectUri, timeoutMs })
  await callback.listening
  try {
    open(authorizationUrl.toString())
  } catch (error) {
    callback.close()
    throw error
  }
  const code = await callback.code
  let credentials = await exchangeAuthorizationCode({ code, codeVerifier: verifier, redirectUri, fetchImpl })
  try {
    credentials = { ...credentials, user: await fetchUserInfo(credentials.access_token, { fetchImpl }) }
  } catch {
    credentials = { ...credentials, user: null }
  }
  await saveCredentials(credentials, options)
  return credentials
}

function explicitApiKey(options) {
  return (
    options?.accessToken ||
    options?.apiKey ||
    process.env.BHARATCODE_ACCESS_TOKEN ||
    process.env.BHARATCODE_API_KEY ||
    process.env.OPENCODE_BHARATCODE_API_KEY ||
    undefined
  )
}

function authError(error) {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(
    `BharatCode needs you to sign in again. I opened the BharatCode sign-in page in your browser; complete it there, then retry your message.${detail ? `\n\n${detail}` : ""}`,
  )
}

async function interactiveLogin(options, reason) {
  interactiveLoginPromise ??= loginWithBrowser({
    ...options,
    timeoutMs: options.authTimeoutMs ?? 180000,
  }).finally(() => {
    interactiveLoginPromise = undefined
  })

  try {
    return await interactiveLoginPromise
  } catch (error) {
    throw authError(error || reason)
  }
}

async function credentials(options, { forceRefresh = false } = {}) {
  const current = await readCredentials(options)
  if (current && !forceRefresh && !shouldRefreshToken(current)) return current

  if (current?.refresh_token) {
    try {
      const refreshed = await refreshCredentials(current, options)
      await saveCredentials(refreshed, options)
      return refreshed
    } catch (error) {
      return interactiveLogin(options, error)
    }
  }

  return interactiveLogin(options, new Error("No BharatCode refresh token found."))
}

async function bearerToken(options, authOptions) {
  const token = explicitApiKey(options)
  if (token) return token

  const item = await credentials(options, authOptions)
  if (!item?.access_token) throw authError(new Error("BharatCode sign-in did not return an access token."))
  return item.access_token
}

function withBearer(init, token) {
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${token}`)
  return { ...(init ?? {}), headers }
}

function authFetch(options) {
  return async (input, init) => {
    const fetchImpl = options.fetchImpl ?? fetch
    const firstToken = await bearerToken(options)
    const first = await fetchImpl(input, withBearer(init, firstToken))
    if (first.status !== 401) return first

    try {
      await first.body?.cancel?.()
    } catch {}
    const secondToken = await bearerToken(options, { forceRefresh: true })
    return fetchImpl(input, withBearer(init, secondToken))
  }
}

function setBearerHeader(output, token) {
  output.headers ||= {}
  for (const name of Object.keys(output.headers)) {
    if (name.toLowerCase() === "authorization") delete output.headers[name]
  }
  output.headers.Authorization = `Bearer ${token}`
}

export const BharatCodePlugin = async (_ctx, options = {}) => {
  const selectedModel = configuredModel(options.model)
  const selectedSmallModel = configuredModel(options.small_model ?? selectedModel)
  const providerOptions = {
    baseURL: options.baseURL || DEFAULT_BASE_URL,
    timeout: options.timeout ?? 1800000,
    chunkTimeout: options.chunkTimeout ?? 180000,
    apiKey: explicitApiKey(options) || "bharatcode-desktop-oauth",
    fetch: authFetch(options),
  }

  return {
    config: async (config) => {
      validateExistingConfigModels(config)
      config.model = selectedModel
      config.small_model = selectedSmallModel

      config.compaction = {
        ...(config.compaction || {}),
        auto: options.autoCompaction ?? false,
      }

      config.agent = config.agent || {}
      for (const name of ["build", "plan"]) {
        config.agent[name] = {
          ...(config.agent[name] || {}),
          model: selectedModel,
          temperature: options.temperature ?? 0.6,
          top_p: options.topP ?? 0.95,
          steps: options.steps ?? 16,
        }
      }

      for (const name of ["title", "compaction"]) {
        config.agent[name] = {
          ...(config.agent[name] || {}),
          model: selectedSmallModel,
          temperature: options.temperature ?? 0.6,
          top_p: options.topP ?? 0.95,
          steps: options.smallSteps ?? 3,
        }
      }

      config.provider = config.provider || {}
      config.provider[PROVIDER_ID] = {
        npm: "@ai-sdk/openai-compatible",
        name: "BharatCode",
        options: providerOptions,
        models: {
          [MODEL_ID]: {
            name: "BharatCode Qwen3.6 35B-A3B AWQ 200K Vision Thinking",
            ...MODEL_CAPABILITIES,
            limit: {
              context: options.context ?? 200000,
              output: options.output ?? 32000,
            },
          },
        },
      }
    },
    "chat.headers": async (_input, output) => {
      setBearerHeader(output, await bearerToken(options))
    },
  }
}

export default BharatCodePlugin
