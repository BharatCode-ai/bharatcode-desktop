import { createSidecarAuthorizationPolicy } from "./sidecar-auth"

const DESKTOP_REDIRECT_URI = "bharatcode://auth/callback"
const AUTHORIZATION_ORIGIN = "https://evgvlcaxfpwupaiwzqqm.supabase.co"
const AUTHORIZATION_PATH = "/auth/v1/oauth/authorize"

export type BharatCodeSidecarConnection = {
  url: string
  username: string
  password: string
}

export type BharatCodeAccountState = "signed_out" | "signed_in" | "needs_sign_in" | "connection_issue"

export type BharatCodeAccountStatus = {
  state: BharatCodeAccountState
  authenticated: boolean
  checkedAt: string
  email?: string
  name?: string
  expiresAt?: number
  message?: string
}

type ClientOptions = {
  getConnection: () => Promise<BharatCodeSidecarConnection>
  fetchImpl?: typeof fetch
  now?: () => Date
}

export function createBharatCodeAccountClient(options: ClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => new Date())

  const request = async (path: string, init: RequestInit = {}) => {
    const connection = await options.getConnection()
    const policy = createSidecarAuthorizationPolicy({
      origin: connection.url,
      username: connection.username,
      password: connection.password,
    })
    const target = new URL(path, policy.origin)
    if (target.origin !== policy.origin) throw new Error("BharatCode sidecar request escaped its loopback origin.")
    const headers = policy.authorize(target.toString(), new Headers(init.headers))
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json")
    const response = await fetchImpl(target, { ...init, headers, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error("The BharatCode sidecar returned an unsafe redirect.")
    }
    const body = await response.text()
    const value = body ? parseJson(body) : {}
    if (!response.ok) throw new SidecarRequestError(response.status, safeErrorMessage(value, response.status))
    return value
  }

  const getAccountStatus = async () => {
    try {
      return projectStatus(await request("/account/status"), now())
    } catch (error) {
      if (!(error instanceof SidecarRequestError) || error.status !== 503) throw error
      return {
        state: "connection_issue",
        authenticated: false,
        checkedAt: now().toISOString(),
        message: "BharatCode account storage is unavailable. Check local credential-store access, then retry.",
      } satisfies BharatCodeAccountStatus
    }
  }
  const refreshAccountStatus = getAccountStatus

  const beginSignIn = async (input: { selectAccount?: boolean } = {}) => {
    const value = await request("/account/authorize", {
      method: "POST",
      body: JSON.stringify({ redirectUri: DESKTOP_REDIRECT_URI, selectAccount: input.selectAccount === true }),
    })
    if (!isRecord(value) || typeof value.url !== "string" || typeof value.expiresAt !== "number") {
      throw new Error("The BharatCode sidecar returned an invalid authorization response.")
    }
    const url = new URL(value.url)
    if (url.origin !== AUTHORIZATION_ORIGIN || url.pathname !== AUTHORIZATION_PATH || url.protocol !== "https:") {
      throw new Error("The BharatCode sidecar returned an unsafe authorization URL.")
    }
    return { url: url.toString(), expiresAt: value.expiresAt }
  }

  const completeSignIn = async (callbackUrl: string) =>
    projectStatus(await request("/account/callback", { method: "POST", body: JSON.stringify({ callbackUrl }) }), now())

  const logout = async () => {
    await request("/account/logout", { method: "POST", body: "{}" })
    return {
      state: "signed_out",
      authenticated: false,
      checkedAt: now().toISOString(),
    } satisfies BharatCodeAccountStatus
  }

  return { getAccountStatus, beginSignIn, completeSignIn, logout, refreshAccountStatus }
}

export function isBharatCodeAuthCallback(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === "bharatcode:" && url.hostname === "auth" && url.pathname === "/callback"
  } catch {
    return false
  }
}

function projectStatus(input: unknown, checkedAt: Date): BharatCodeAccountStatus {
  if (!isRecord(input) || typeof input.state !== "string") {
    throw new Error("The BharatCode sidecar returned an invalid account response.")
  }
  const common = {
    checkedAt: checkedAt.toISOString(),
    ...(typeof input.message === "string" ? { message: input.message } : {}),
  }
  if (input.state === "signed-out") return { ...common, state: "signed_out", authenticated: false }
  if (input.state === "sign-in-required") return { ...common, state: "needs_sign_in", authenticated: false }
  if (input.state === "connection-problem") return { ...common, state: "connection_issue", authenticated: true }
  if (input.state !== "signed-in") throw new Error("The BharatCode sidecar returned an invalid account state.")
  return {
    ...common,
    state: "signed_in",
    authenticated: true,
    ...(typeof input.email === "string" ? { email: input.email } : {}),
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt) ? { expiresAt: input.expiresAt } : {}),
  }
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    throw new Error("The BharatCode sidecar returned an invalid response.")
  }
}

function safeErrorMessage(input: unknown, status: number) {
  if (isRecord(input) && isRecord(input.error) && typeof input.error.message === "string") return input.error.message
  return `BharatCode account request failed (${status}).`
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

class SidecarRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
