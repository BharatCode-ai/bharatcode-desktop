import { createHash, randomBytes } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { Auth } from "@/auth"
import { serviceUse } from "@/effect/service-use"
import { NonNegativeInt } from "@opencode-ai/core/schema"

export const PROVIDER_ID = "bharatcode"
export const API_BASE_URL = "https://bharatcode.ai"
export const MODEL_API_BASE_URL = `${API_BASE_URL}/api/model/v1`
export const OAUTH_ISSUER = "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1"
export const OAUTH_CLIENT_ID = "4cad332a-232f-4ef2-9363-12fea4420635"
export const OAUTH_SCOPE = "openid email profile"
export const CLI_REDIRECT_URI = "http://127.0.0.1:27182/callback"
export const DESKTOP_REDIRECT_URI = "bharatcode://auth/callback"

const REFRESH_SKEW_MS = 300_000
const AUTHORIZATION_TTL_MS = 180_000
const TOKEN_REQUEST_TIMEOUT_MS = 30_000
const TERMINAL_REFRESH_CODES = new Set(["refresh_token_not_found", "refresh_token_already_used"])
const APPROVED_REDIRECTS = new Set([CLI_REDIRECT_URI, DESKTOP_REDIRECT_URI])
const API_ORIGIN = new URL(API_BASE_URL).origin

export class TransportError extends Schema.TaggedErrorClass<TransportError>()("BharatCodeTransportError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class ServiceError extends Schema.TaggedErrorClass<ServiceError>()("BharatCodeServiceError", {
  operation: Schema.String,
  status: NonNegativeInt,
  errorCode: Schema.optional(Schema.String),
  retriable: Schema.Boolean,
  message: Schema.String,
}) {}

export class SignInRequired extends Schema.TaggedErrorClass<SignInRequired>()("BharatCodeSignInRequired", {
  errorCode: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export class OAuthError extends Schema.TaggedErrorClass<OAuthError>()("BharatCodeOAuthError", {
  reason: Schema.Literals(["redirect", "state", "expired", "callback", "response"]),
  message: Schema.String,
}) {}

export type Error = TransportError | ServiceError | SignInRequired | OAuthError | Auth.AuthError

export type Identity = {
  sub: string
  email?: string
  emailVerified?: boolean
  name?: string
  picture?: string
}

export type Status =
  | { state: "signed-out" }
  | { state: "sign-in-required"; accountID?: string; errorCode?: string; message: string }
  | { state: "connection-problem"; accountID?: string; message: string }
  | { state: "signed-in"; accountID: string; email?: string; name?: string; picture?: string; expiresAt: number }

export type Authorization = {
  url: string
  state: string
  expiresAt: number
}

export interface Interface {
  readonly accountID: () => Effect.Effect<string | undefined, Auth.AuthError>
  readonly accessToken: (options?: { forceRefresh?: boolean; staleToken?: string }) => Effect.Effect<string, Error>
  readonly authenticatedFetch: (input: string | URL | Request, init?: RequestInit) => Effect.Effect<Response, Error>
  readonly beginAuthorization: (input: {
    redirectUri: string
    selectAccount?: boolean
  }) => Effect.Effect<Authorization, OAuthError>
  readonly completeAuthorization: (callbackUrl: string) => Effect.Effect<Identity, Error>
  readonly cancelAuthorization: (state: string) => Effect.Effect<void>
  readonly identity: () => Effect.Effect<Identity, Error>
  readonly status: () => Effect.Effect<Status, Auth.AuthError>
  readonly logout: () => Effect.Effect<void, Auth.AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BharatCodeAccount") {}

export const use = serviceUse(Service)

type PendingAuthorization = {
  verifier: string
  redirectUri: string
  expiresAt: number
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type FailureBody = {
  error_code?: unknown
  error?: unknown
  error_description?: unknown
  msg?: unknown
  message?: unknown
}

export type LayerOptions = {
  fetch?: Fetch
  now?: () => number
  tokenRequestTimeoutMs?: number
}

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function base64Url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url")
}

function challenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}

function callbackBase(url: URL) {
  if (url.protocol === "bharatcode:") return `${url.protocol}//${url.host}${url.pathname}`
  return `${url.protocol}//${url.host}${url.pathname}`
}

function bearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${token}`)
  return { ...init, headers, redirect: "manual" }
}

function approvedApiRequest(input: string | URL | Request) {
  try {
    const url = new URL(input instanceof Request ? input.url : input)
    return url.origin === API_ORIGIN && !url.username && !url.password
  } catch {
    return false
  }
}

function stringField(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined
}

function parseIdentity(value: unknown): Identity | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  const sub = stringField(input.sub)
  if (!sub) return
  return {
    sub,
    email: stringField(input.email),
    emailVerified: typeof input.email_verified === "boolean" ? input.email_verified : undefined,
    name: stringField(input.name),
    picture: stringField(input.picture),
  }
}

function accountChanged(operation: string) {
  return new ServiceError({
    operation,
    status: 409,
    errorCode: "account_changed",
    retriable: false,
    message: "The BharatCode account changed while the operation was in flight. Retry the operation.",
  })
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const fetchImpl = options.fetch ?? globalThis.fetch
      const now = options.now ?? Date.now
      const tokenRequestTimeoutMs =
        options.tokenRequestTimeoutMs &&
        Number.isFinite(options.tokenRequestTimeoutMs) &&
        options.tokenRequestTimeoutMs > 0
          ? options.tokenRequestTimeoutMs
          : TOKEN_REQUEST_TIMEOUT_MS
      const pending = new Map<string, PendingAuthorization>()
      let lastTerminal: SignInRequired | undefined

      const fetchToken = (params: Record<string, string>) => {
        const controller = new AbortController()
        let rejectAbort!: (reason: unknown) => void
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAbort = reject
        })
        const abort = () => rejectAbort(controller.signal.reason ?? new Error("Request aborted."))
        controller.signal.addEventListener("abort", abort, { once: true })
        let response: Response | undefined
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, tokenRequestTimeoutMs)
        const request = Promise.resolve().then(async () => {
          response = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params),
            signal: controller.signal,
          })
          const value = await response.json().then(
            (value) => value as Record<string, unknown>,
            (error) => {
              if (controller.signal.aborted) throw error
              return {} as Record<string, unknown>
            },
          )
          return { response, value }
        })

        return Promise.race([request, aborted]).finally(() => {
          clearTimeout(timer)
          controller.signal.removeEventListener("abort", abort)
          if (timedOut) void response?.body?.cancel().catch(() => undefined)
        })
      }

      const execute = Effect.fn("BharatCodeAccount.fetch")(function* (
        operation: string,
        input: string | URL | Request,
        init?: RequestInit,
      ) {
        return yield* Effect.tryPromise({
          try: () => fetchImpl(input, init),
          catch: () =>
            new TransportError({
              operation,
              message: `BharatCode ${operation} could not reach the service.`,
            }),
        })
      })

      const body = Effect.fn("BharatCodeAccount.responseBody")(function* (response: Response) {
        return yield* Effect.promise(() =>
          response.json().then(
            (value) => value as Record<string, unknown>,
            () => ({}) as Record<string, unknown>,
          ),
        )
      })

      const httpFailure = (operation: string, response: Response, value: FailureBody) => {
        const errorCode = stringField(value.error_code) ?? stringField(response.headers.get("x-sb-error-code"))
        if (response.status === 400 && errorCode && TERMINAL_REFRESH_CODES.has(errorCode)) {
          return new SignInRequired({
            errorCode,
            message: "Your BharatCode session is no longer valid. Sign in again.",
          })
        }
        return new ServiceError({
          operation,
          status: response.status,
          errorCode,
          retriable: response.status === 429 || response.status >= 500,
          message: `BharatCode ${operation} failed (${response.status}).`,
        })
      }

      const postToken = Effect.fn("BharatCodeAccount.postToken")(function* (params: Record<string, string>) {
        const { response, value } = yield* Effect.tryPromise({
          try: () => fetchToken(params),
          catch: () =>
            new TransportError({
              operation: "token request",
              message: "BharatCode token request could not reach the service.",
            }),
        })
        if (!response.ok) return yield* httpFailure("token request", response, value)
        const access = stringField(value.access_token)
        if (!access) {
          return yield* new ServiceError({
            operation: "token request",
            status: 502,
            retriable: false,
            message: "BharatCode token response was invalid.",
          })
        }
        return {
          access_token: access,
          refresh_token: stringField(value.refresh_token),
          expires_in: typeof value.expires_in === "number" ? value.expires_in : undefined,
        }
      })

      type AccessOutcome =
        | { type: "success"; token: string; accountID?: string }
        | { type: "failure"; error: SignInRequired | ServiceError }

      const accessCredential = Effect.fn("BharatCodeAccount.accessCredential")(function* (
        input: {
          forceRefresh?: boolean
          staleToken?: string
          staleAccountID?: string
          protectAccountSwitch?: boolean
        } = {},
      ) {
        const outcome = yield* auth.transaction<AccessOutcome, TransportError | ServiceError, never>(
          PROVIDER_ID,
          (current) =>
            Effect.gen(function* () {
              if (!current || current.type !== "oauth") {
                const error = new SignInRequired({ message: "Sign in to BharatCode to continue." })
                return {
                  action: "keep",
                  result: { type: "failure", error },
                } satisfies Auth.TransactionResult<AccessOutcome>
              }
              if (
                input.protectAccountSwitch &&
                input.staleToken &&
                (current.accountId !== input.staleAccountID ||
                  (current.access !== input.staleToken && !input.staleAccountID))
              ) {
                const error = accountChanged("authenticated request")
                return {
                  action: "keep",
                  result: { type: "failure", error },
                } satisfies Auth.TransactionResult<AccessOutcome>
              }
              if (input.staleToken && current.access && current.access !== input.staleToken) {
                return {
                  action: "keep",
                  result: { type: "success", token: current.access, accountID: current.accountId },
                } satisfies Auth.TransactionResult<AccessOutcome>
              }
              if (!input.forceRefresh && current.access && current.expires - now() > REFRESH_SKEW_MS) {
                return {
                  action: "keep",
                  result: { type: "success", token: current.access, accountID: current.accountId },
                } satisfies Auth.TransactionResult<AccessOutcome>
              }
              if (!current.refresh) {
                const error = new SignInRequired({ message: "Your BharatCode session is incomplete. Sign in again." })
                return {
                  action: "remove",
                  result: { type: "failure", error },
                } satisfies Auth.TransactionResult<AccessOutcome>
              }

              const refreshed = yield* postToken({
                grant_type: "refresh_token",
                refresh_token: current.refresh,
                client_id: OAUTH_CLIENT_ID,
              }).pipe(
                Effect.map((value) => ({ ok: true as const, value })),
                Effect.catchTag("BharatCodeSignInRequired", (error) => Effect.succeed({ ok: false as const, error })),
              )
              if (!refreshed.ok) {
                return {
                  action: "remove",
                  result: { type: "failure", error: refreshed.error },
                } satisfies Auth.TransactionResult<AccessOutcome>
              }

              const info = new Auth.Oauth({
                ...current,
                access: refreshed.value.access_token,
                refresh: refreshed.value.refresh_token ?? current.refresh,
                expires: now() + (refreshed.value.expires_in ?? 3600) * 1000,
              })
              return {
                action: "set",
                info,
                result: { type: "success", token: info.access, accountID: info.accountId },
              } satisfies Auth.TransactionResult<AccessOutcome>
            }),
        )
        if (outcome.type === "failure") {
          if (outcome.error instanceof SignInRequired) lastTerminal = outcome.error
          return yield* outcome.error
        }
        lastTerminal = undefined
        return outcome
      })

      const accessToken: Interface["accessToken"] = Effect.fn("BharatCodeAccount.accessToken")(function* (
        input: { forceRefresh?: boolean; staleToken?: string } = {},
      ) {
        return (yield* accessCredential(input)).token
      })

      const authenticatedFetch: Interface["authenticatedFetch"] = Effect.fn("BharatCodeAccount.authenticatedFetch")(
        function* (input: string | URL | Request, init?: RequestInit) {
          if (!approvedApiRequest(input)) {
            return yield* new ServiceError({
              operation: "authenticated request",
              status: 400,
              errorCode: "origin_not_allowed",
              retriable: false,
              message: "BharatCode rejected an unapproved API destination.",
            })
          }
          const firstCredential = yield* accessCredential()
          const first = yield* execute("authenticated request", input, bearer(init, firstCredential.token))
          if (first.status !== 401) return first
          yield* Effect.promise(() => first.body?.cancel().catch(() => undefined) ?? Promise.resolve())
          const secondCredential = yield* accessCredential({
            forceRefresh: true,
            staleToken: firstCredential.token,
            staleAccountID: firstCredential.accountID,
            protectAccountSwitch: true,
          })
          const second = yield* execute("authenticated request", input, bearer(init, secondCredential.token))
          if (second.status !== 401) return second
          yield* Effect.promise(() => second.body?.cancel().catch(() => undefined) ?? Promise.resolve())
          const error = new SignInRequired({
            message: "Your BharatCode session is no longer valid. Sign in again.",
          })
          yield* auth.transaction(PROVIDER_ID, (current) =>
            Effect.succeed(
              current?.type === "oauth" &&
                current.access === secondCredential.token &&
                current.accountId === secondCredential.accountID
                ? { action: "remove" as const, result: undefined }
                : { action: "keep" as const, result: undefined },
            ),
          )
          lastTerminal = error
          return yield* error
        },
      )

      const fetchIdentityWith = Effect.fn("BharatCodeAccount.fetchIdentityWith")(function* (token: string) {
        const response = yield* execute("identity request", `${OAUTH_ISSUER}/oauth/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        })
        const value = yield* body(response)
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            return yield* new SignInRequired({
              errorCode: stringField(value.error_code),
              message: "Your BharatCode session is no longer valid. Sign in again.",
            })
          }
          return yield* httpFailure("identity request", response, value)
        }
        const identity = parseIdentity(value)
        if (!identity) {
          return yield* new ServiceError({
            operation: "identity request",
            status: 502,
            retriable: false,
            message: "BharatCode identity response did not include a stable account ID.",
          })
        }
        return identity
      })

      const identity: Interface["identity"] = Effect.fn("BharatCodeAccount.identity")(function* () {
        const firstCredential = yield* accessCredential()
        const first = yield* fetchIdentityWith(firstCredential.token).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTag("BharatCodeSignInRequired", (error) => Effect.succeed({ ok: false as const, error })),
        )
        if (first.ok) return first.value

        const secondCredential = yield* accessCredential({
          forceRefresh: true,
          staleToken: firstCredential.token,
        })
        const second = yield* fetchIdentityWith(secondCredential.token).pipe(
          Effect.catchTag("BharatCodeSignInRequired", (error) =>
            auth
              .transaction(PROVIDER_ID, (current) => {
                const sameCredential =
                  current?.type === "oauth" &&
                  current.access === secondCredential.token &&
                  current.accountId === secondCredential.accountID
                return Effect.succeed(
                  sameCredential
                    ? { action: "remove" as const, result: true }
                    : { action: "keep" as const, result: false },
                )
              })
              .pipe(
                Effect.flatMap((removed): Effect.Effect<never, SignInRequired | ServiceError> => {
                  if (!removed) return Effect.fail(accountChanged("identity request"))
                  lastTerminal = error
                  return Effect.fail(error)
                }),
              ),
          ),
        )
        return second
      })

      const beginAuthorization = Effect.fn("BharatCodeAccount.beginAuthorization")(function* (input: {
        redirectUri: string
        selectAccount?: boolean
      }) {
        if (!APPROVED_REDIRECTS.has(input.redirectUri)) {
          return yield* new OAuthError({
            reason: "redirect",
            message: "BharatCode authorization rejected an unregistered callback URL.",
          })
        }
        const verifier = base64Url(randomBytes(32))
        const state = base64Url(randomBytes(24))
        const expiresAt = now() + AUTHORIZATION_TTL_MS
        pending.set(state, { verifier, redirectUri: input.redirectUri, expiresAt })

        const url = new URL(`${OAUTH_ISSUER}/oauth/authorize`)
        url.searchParams.set("client_id", OAUTH_CLIENT_ID)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("redirect_uri", input.redirectUri)
        url.searchParams.set("scope", OAUTH_SCOPE)
        url.searchParams.set("code_challenge", challenge(verifier))
        url.searchParams.set("code_challenge_method", "S256")
        url.searchParams.set("state", state)
        if (input.selectAccount) url.searchParams.set("prompt", "select_account")
        return { url: url.toString(), state, expiresAt }
      })

      const completeAuthorization = Effect.fn("BharatCodeAccount.completeAuthorization")(function* (
        callbackUrl: string,
      ) {
        const url = yield* Effect.try({
          try: () => new URL(callbackUrl),
          catch: () => new OAuthError({ reason: "callback", message: "BharatCode callback URL was invalid." }),
        })
        const state = url.searchParams.get("state")
        const match = state ? pending.get(state) : undefined
        if (!state || !match) {
          return yield* new OAuthError({ reason: "state", message: "BharatCode authorization state did not match." })
        }
        pending.delete(state)
        if (match.expiresAt <= now()) {
          return yield* new OAuthError({ reason: "expired", message: "BharatCode authorization timed out." })
        }
        if (callbackBase(url) !== match.redirectUri) {
          return yield* new OAuthError({ reason: "redirect", message: "BharatCode callback URL did not match." })
        }
        const callbackError = url.searchParams.get("error")
        if (callbackError) {
          return yield* new OAuthError({ reason: "response", message: "BharatCode authorization was not completed." })
        }
        const code = url.searchParams.get("code")
        if (!code) {
          return yield* new OAuthError({ reason: "callback", message: "BharatCode callback did not include a code." })
        }

        const token = yield* postToken({
          grant_type: "authorization_code",
          code,
          redirect_uri: match.redirectUri,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: match.verifier,
        })
        if (!token.refresh_token) {
          return yield* new OAuthError({
            reason: "response",
            message: "BharatCode authorization did not return a renewable session.",
          })
        }
        const info = yield* fetchIdentityWith(token.access_token)
        yield* auth.transaction(PROVIDER_ID, () =>
          Effect.succeed({
            action: "set" as const,
            info: new Auth.Oauth({
              type: "oauth",
              access: token.access_token,
              refresh: token.refresh_token!,
              expires: now() + (token.expires_in ?? 3600) * 1000,
              accountId: info.sub,
            }),
            result: undefined,
          }),
        )
        lastTerminal = undefined
        return info
      })

      const status = Effect.fn("BharatCodeAccount.status")(function* () {
        const current = yield* auth.get(PROVIDER_ID)
        if (!current || current.type !== "oauth") {
          if (lastTerminal) {
            return {
              state: "sign-in-required" as const,
              errorCode: lastTerminal.errorCode,
              message: lastTerminal.message,
            }
          }
          return { state: "signed-out" as const }
        }
        const checked = yield* identity().pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        )
        if (checked.ok) {
          const latest = yield* auth.get(PROVIDER_ID)
          if (!latest || latest.type !== "oauth") return { state: "signed-out" as const }
          if (latest.accountId && latest.accountId !== checked.value.sub) {
            return {
              state: "connection-problem" as const,
              accountID: latest.accountId,
              message: "The BharatCode account changed while status was updating. Refresh status.",
            }
          }
          return {
            state: "signed-in" as const,
            accountID: checked.value.sub,
            email: checked.value.email,
            name: checked.value.name,
            picture: checked.value.picture,
            expiresAt: latest.expires,
          }
        }
        if (checked.error instanceof SignInRequired) {
          return {
            state: "sign-in-required" as const,
            accountID: current.accountId,
            errorCode: checked.error.errorCode,
            message: checked.error.message,
          }
        }
        return {
          state: "connection-problem" as const,
          accountID: current.accountId,
          message: checked.error.message,
        }
      })

      const logout = Effect.fn("BharatCodeAccount.logout")(function* () {
        yield* auth.remove(PROVIDER_ID)
        lastTerminal = undefined
      })

      const cancelAuthorization = Effect.fn("BharatCodeAccount.cancelAuthorization")((state: string) =>
        Effect.sync(() => {
          pending.delete(state)
        }),
      )

      const accountID = Effect.fn("BharatCodeAccount.accountID")(function* () {
        const current = yield* auth.get(PROVIDER_ID)
        return current?.type === "oauth" ? current.accountId : undefined
      })

      return Service.of({
        accountID,
        accessToken,
        authenticatedFetch,
        beginAuthorization,
        completeAuthorization,
        cancelAuthorization,
        identity,
        status,
        logout,
      })
    }),
  )

export const layer = layerWith()
export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer))

export * as BharatCodeAccount from "./account"
