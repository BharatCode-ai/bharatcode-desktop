import { expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BharatCodeAuth } from "@opencode-ai/core/bharatcode-auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeLoopback } from "@/bharatcode/loopback"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

function token(issuer: string, revision = 0) {
  return `e30.${Buffer.from(JSON.stringify({ iss: issuer, sub: "fixture-user", revision })).toString("base64url")}.fixture`
}

// Real loopback HTTP, synthetic OAuth responses, no external auth/browser or
// fetch mocks. This verifies native code, not a Desktop GUI or Supabase login.
function fixture(options: { issuer?: string; redirect?: "token" | "userinfo"; malformed?: "token" | "userinfo" } = {}) {
  const requests: string[] = []
  const grants: URLSearchParams[] = []
  const codes = new Map<string, URLSearchParams>()
  const tokens = new Set<string>()
  const state = { refresh: "", revision: 0, escaped: 0, issuer: options.issuer }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname === "/escaped") {
        state.escaped++
        return Response.json({ error: "credentials_must_not_reach_redirects" }, { status: 500 })
      }
      if (url.pathname === "/auth/v1/oauth/authorize") {
        const code = `code-${codes.size}`
        codes.set(code, url.searchParams)
        const callback = new URL(url.searchParams.get("redirect_uri")!)
        callback.searchParams.set("state", url.searchParams.get("state")!)
        callback.searchParams.set("code", code)
        return new Response(null, { status: 302, headers: { location: callback.toString() } })
      }
      if (url.pathname === "/auth/v1/oauth/token") {
        const form = new URLSearchParams(await request.text())
        grants.push(form)
        if (options.redirect === "token") {
          return new Response(null, { status: 307, headers: { location: `${url.origin}/escaped` } })
        }
        if (options.malformed === "token") return Response.json(null)
        if (
          request.method !== "POST" ||
          request.headers.get("content-type") !== "application/x-www-form-urlencoded" ||
          form.get("client_id") !== BharatCodeAccount.OAUTH_CLIENT_ID
        ) {
          return Response.json({ error: "invalid_request" }, { status: 400 })
        }
        if (form.get("grant_type") === "authorization_code") {
          const authorization = codes.get(form.get("code")!)
          codes.delete(form.get("code")!)
          if (
            !authorization ||
            form.get("redirect_uri") !== authorization.get("redirect_uri") ||
            createHash("sha256").update(form.get("code_verifier")!).digest("base64url") !==
              authorization.get("code_challenge")
          ) {
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
        } else if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== state.refresh) {
          return Response.json({ error_code: "refresh_token_not_found" }, { status: 400 })
        }
        state.revision++
        state.refresh = `refresh-${state.revision}`
        const access = token(state.issuer ?? `${url.origin}/auth/v1`, state.revision)
        tokens.add(access)
        return Response.json({ access_token: access, refresh_token: state.refresh, expires_in: 3600 })
      }
      if (url.pathname === "/auth/v1/oauth/userinfo") {
        if (options.redirect === "userinfo") {
          return new Response(null, { status: 302, headers: { location: `${url.origin}/escaped` } })
        }
        if (options.malformed === "userinfo") return Response.json(null)
        if (!tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) {
          return Response.json({ error: "invalid_token" }, { status: 401 })
        }
        return Response.json({ sub: "fixture-user", email: "fixture@example.test", name: "Local Fixture" })
      }
      return new Response(null, { status: 404 })
    },
  })
  return { server, origin: server.url.origin, requests, grants, state }
}

const localAuth = (options?: Parameters<typeof fixture>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => fixture(options)),
    (value) => Effect.promise(() => value.server.stop(true)),
  )

function accountLayer(directory: string, env: BharatCodeAuth.Environment) {
  const storage = Auth.layer.pipe(
    Layer.provide(LayerNode.compile(FSUtil.node)),
    Layer.provide(
      Global.layerWith({ auth: path.join(directory, "data", "auth.json"), state: path.join(directory, "state") }),
    ),
  )
  return BharatCodeAccount.layerWith({ env }).pipe(Layer.provideMerge(storage))
}

for (const [name, redirectUri, key] of [
  ["Desktop custom scheme", BharatCodeAccount.DESKTOP_REDIRECT_URI, "BHARATCODE_AUTH_URL"],
  ["CLI loopback with legacy env", BharatCodeAccount.CLI_REDIRECT_URI, "OPENCODE_AUTH_URL"],
] as const) {
  it.live(`${name}: authorize, callback, PKCE, UserInfo and refresh through the shared implementation`, () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const local = yield* localAuth()
      yield* Effect.gen(function* () {
        const account = yield* BharatCodeAccount.Service
        const auth = yield* Auth.Service
        yield* auth.set("unrelated-provider", new Auth.Api({ type: "api", key: "synthetic-unrelated-key" }))
        const authorization = yield* account.beginAuthorization({ redirectUri, selectAccount: true })
        const url = new URL(authorization.url)
        expect(url.origin + url.pathname).toBe(`${local.origin}/auth/v1/oauth/authorize`)
        expect(url.searchParams.get("client_id")).toBe("4cad332a-232f-4ef2-9363-12fea4420635")
        expect(url.searchParams.get("scope")).toBe("openid email profile")
        expect(url.searchParams.get("response_type")).toBe("code")
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/)
        expect(url.searchParams.get("prompt")).toBe("select_account")
        expect(url.searchParams.get("redirect_uri")).toBe(redirectUri)
        expect(url.searchParams.has("code_verifier")).toBe(false)
        expect(authorization).not.toHaveProperty("verifier")

        const invalid = yield* account.completeAuthorization(`${redirectUri}?code=unused&state=wrong`).pipe(Effect.flip)
        expect(invalid).toMatchObject({ _tag: "BharatCodeOAuthError", reason: "state" })
        const response = yield* Effect.promise(() => fetch(authorization.url, { redirect: "manual" }))
        expect(response.status).toBe(302)
        const callback = response.headers.get("location")!
        if (redirectUri === BharatCodeAccount.CLI_REDIRECT_URI) {
          const listener = yield* Effect.acquireRelease(
            Effect.promise(() => BharatCodeLoopback.start({ expectedState: authorization.state, timeoutMs: 5_000 })),
            (session) => Effect.sync(session.close),
          )
          const bad = yield* Effect.promise(() => fetch(`${redirectUri}?code=unused&state=wrong`))
          expect(bad.status).toBe(400)
          yield* Effect.promise(() => bad.text())
          const received = yield* Effect.promise(() => fetch(callback))
          expect(received.status).toBe(200)
          yield* Effect.promise(() => received.text())
          expect(yield* Effect.promise(() => listener.callback)).toBe(callback)
        }
        expect(yield* account.completeAuthorization(callback)).toMatchObject({ sub: "fixture-user" })
        expect(local.grants[0].get("code_verifier")).toMatch(/^[\w-]{43}$/)
        expect(yield* account.status()).toMatchObject({ state: "signed-in", accountID: "fixture-user" })
        expect(yield* auth.get("bharatcode")).toMatchObject({ refresh: "refresh-1", accountId: "fixture-user" })

        const refreshed = yield* account.accessToken({ forceRefresh: true })
        expect(refreshed).toBe(token(`${local.origin}/auth/v1`, 2))
        expect(local.grants[1].get("grant_type")).toBe("refresh_token")
        expect(local.grants[1].get("refresh_token")).toBe("refresh-1")
        expect(local.grants[1].has("code_verifier")).toBe(false)
        expect(yield* auth.get("bharatcode")).toMatchObject({ access: refreshed, refresh: "refresh-2" })
        expect(yield* account.identity()).toMatchObject({ sub: "fixture-user" })
        expect(yield* account.completeAuthorization(callback).pipe(Effect.flip)).toMatchObject({ reason: "state" })
        expect(local.grants).toHaveLength(2)
        expect(yield* auth.get("unrelated-provider")).toEqual(
          new Auth.Api({ type: "api", key: "synthetic-unrelated-key" }),
        )
        local.state.issuer = "https://unexpected.invalid/auth/v1"
        const previous = yield* auth.get("bharatcode")
        expect(yield* account.accessToken({ forceRefresh: true }).pipe(Effect.flip)).toMatchObject({
          _tag: "BharatCodeServiceError",
          errorCode: "issuer_mismatch",
        })
        expect(yield* auth.get("bharatcode")).toEqual(previous)
      }).pipe(Effect.provide(accountLayer(directory, { [key]: local.origin })))
    }),
  )
}

it.live("an old issuer requires fresh sign-in without contacting either issuer or changing native storage", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const local = yield* localAuth()
    yield* Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const auth = yield* Auth.Service
      for (const expires of [0, Date.now() + 3_600_000]) {
        const previous = new Auth.Oauth({
          type: "oauth",
          access: token("https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1"),
          refresh: "old-issuer-refresh",
          expires,
          accountId: "existing-user",
        })
        yield* auth.set("bharatcode", previous)
        expect(yield* account.status()).toMatchObject({ state: "sign-in-required", errorCode: "issuer_mismatch" })
        expect(yield* account.accessToken({ forceRefresh: true }).pipe(Effect.flip)).toMatchObject({
          _tag: "BharatCodeSignInRequired",
          message: expect.stringContaining("Sign in again"),
        })
        expect(yield* auth.get("bharatcode")).toEqual(previous)
      }
      expect(local.requests).toEqual([])
    }).pipe(Effect.provide(accountLayer(directory, { BHARATCODE_AUTH_URL: local.origin })))
  }),
)

it.live("an explicit hosted override retains an installed unexpired session without accepting first-party tokens", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const hosted = "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1"
    yield* Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const auth = yield* Auth.Service
      const previous = new Auth.Oauth({
        type: "oauth",
        access: token(hosted),
        refresh: "installed-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "installed-account",
      })
      yield* auth.set("bharatcode", previous)
      expect(yield* account.accessToken()).toBe(previous.access)
      expect(yield* auth.get("bharatcode")).toEqual(previous)
      const changed = new Auth.Oauth({ ...previous, access: token(BharatCodeAuth.DEFAULT_ISSUER) })
      yield* auth.set("bharatcode", changed)
      expect(yield* account.accessToken().pipe(Effect.flip)).toMatchObject({ errorCode: "issuer_mismatch" })
      expect(yield* auth.get("bharatcode")).toEqual(changed)
    }).pipe(Effect.provide(accountLayer(directory, { OPENCODE_AUTH_URL: hosted })))
  }),
)

it.live("endpoint selection does not migrate or overwrite an installed API key", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const local = yield* localAuth({ malformed: "token" })
    const previous = new Auth.Api({ type: "api", key: "synthetic-installed-api-key" })
    const env = { BHARATCODE_AUTH_URL: local.origin }
    yield* Effect.gen(function* () {
      const auth = yield* Auth.Service
      const account = yield* BharatCodeAccount.Service
      yield* auth.set("bharatcode", previous)
      expect(yield* account.status()).toEqual({ state: "signed-out" })
      const pending = yield* account.beginAuthorization({ redirectUri: BharatCodeAccount.DESKTOP_REDIRECT_URI })
      const response = yield* Effect.promise(() => fetch(pending.url, { redirect: "manual" }))
      expect(yield* account.completeAuthorization(response.headers.get("location")!).pipe(Effect.flip)).toMatchObject({
        _tag: "BharatCodeServiceError",
      })
      expect(yield* auth.get("bharatcode")).toEqual(previous)
    }).pipe(Effect.provide(accountLayer(directory, env)))
    // Recreate services over the same private store; no reset/import is needed.
    yield* Effect.gen(function* () {
      const auth = yield* Auth.Service
      expect(yield* auth.get("bharatcode")).toEqual(previous)
    }).pipe(Effect.provide(accountLayer(directory, env)))
  }),
)

it.live("a persisted first-party session refreshes after runtime restart without changing account identity", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const local = yield* localAuth()
    const env = { BHARATCODE_AUTH_URL: local.origin }
    yield* Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const pending = yield* account.beginAuthorization({ redirectUri: BharatCodeAccount.DESKTOP_REDIRECT_URI })
      const response = yield* Effect.promise(() => fetch(pending.url, { redirect: "manual" }))
      yield* account.completeAuthorization(response.headers.get("location")!)
    }).pipe(Effect.provide(accountLayer(directory, env)))
    yield* Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const auth = yield* Auth.Service
      expect(yield* account.accessToken({ forceRefresh: true })).toBe(token(`${local.origin}/auth/v1`, 2))
      expect(yield* account.status()).toMatchObject({ state: "signed-in", accountID: "fixture-user" })
      expect(yield* auth.get("bharatcode")).toMatchObject({ accountId: "fixture-user", refresh: "refresh-2" })
      expect(local.grants).toHaveLength(2)
    }).pipe(Effect.provide(accountLayer(directory, env)))
  }),
)

for (const options of [
  { issuer: "https://unexpected.invalid/auth/v1" },
  { redirect: "token" },
  { redirect: "userinfo" },
  { malformed: "token" },
  { malformed: "userinfo" },
] as const) {
  it.live(`rejects ${JSON.stringify(options)} without replacing a saved account or following redirects`, () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const local = yield* localAuth(options)
      yield* Effect.gen(function* () {
        const account = yield* BharatCodeAccount.Service
        const auth = yield* Auth.Service
        const previous = new Auth.Oauth({ type: "oauth", access: "saved", refresh: "saved-refresh", expires: 0 })
        yield* auth.set("bharatcode", previous)
        const authorization = yield* account.beginAuthorization({ redirectUri: BharatCodeAccount.DESKTOP_REDIRECT_URI })
        const response = yield* Effect.promise(() => fetch(authorization.url, { redirect: "manual" }))
        expect(yield* account.completeAuthorization(response.headers.get("location")!).pipe(Effect.flip)).toMatchObject(
          {
            _tag: "BharatCodeServiceError",
          },
        )
        expect(local.state.escaped).toBe(0)
        expect(yield* auth.get("bharatcode")).toEqual(previous)
        if ("issuer" in options) expect(local.requests).not.toContain("/auth/v1/oauth/userinfo")
      }).pipe(Effect.provide(accountLayer(directory, { BHARATCODE_AUTH_URL: local.origin })))
    }),
  )
}

it.live("malformed overrides fail authorization and refresh clearly without removing storage", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const auth = yield* Auth.Service
      const previous = new Auth.Oauth({ type: "oauth", access: "saved", refresh: "saved-refresh", expires: 0 })
      yield* auth.set("bharatcode", previous)
      for (const operation of [
        account.beginAuthorization({ redirectUri: BharatCodeAccount.DESKTOP_REDIRECT_URI }).pipe(Effect.asVoid),
        account.accessToken({ forceRefresh: true }).pipe(Effect.asVoid),
      ]) {
        expect(yield* operation.pipe(Effect.flip)).toMatchObject({
          _tag: "BharatCodeOAuthError",
          reason: "configuration",
          message: BharatCodeAuth.configurationMessage,
        })
      }
      expect(yield* auth.get("bharatcode")).toEqual(previous)
    }).pipe(Effect.provide(accountLayer(directory, { BHARATCODE_AUTH_URL: "http://not-loopback.invalid" })))
  }),
)
