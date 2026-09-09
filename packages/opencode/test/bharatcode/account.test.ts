import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Semaphore } from "effect"
import { Auth } from "@/auth"
import { BharatCodeAccount } from "@/bharatcode/account"

function authStore(initial?: Auth.Info) {
  let store: Auth.Store = initial ? { bharatcode: initial } : {}
  const transactionLock = Semaphore.makeUnsafe(1)
  const layer = Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: (key) => Effect.succeed(store[key]),
      all: () => Effect.succeed(store),
      set: (key, info) =>
        Effect.sync(() => {
          store = { ...store, [key]: info }
        }),
      remove: (key) =>
        Effect.sync(() => {
          const next = { ...store }
          delete next[key]
          store = next
        }),
      transaction: (key, callback) =>
        transactionLock.withPermits(1)(
          Effect.gen(function* () {
            const next = yield* callback(store[key])
            if (next.action === "set") store = { ...store, [key]: next.info }
            if (next.action === "remove") {
              const updated = { ...store }
              delete updated[key]
              store = updated
            }
            return next.result
          }),
        ),
    }),
  )
  return { layer, read: () => store.bharatcode }
}

const oauth = (overrides: Partial<Auth.Oauth> = {}) =>
  new Auth.Oauth({
    type: "oauth",
    access: "access-old",
    refresh: "refresh-old",
    expires: 0,
    accountId: "user-old",
    ...overrides,
  })

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function run<A, E>(
  effect: Effect.Effect<A, E, BharatCodeAccount.Service>,
  input: {
    initial?: Auth.Info
    fetch: BharatCodeAccount.Fetch
    now?: () => number
    tokenRequestTimeoutMs?: number
  },
) {
  const store = authStore(input.initial)
  const layer = BharatCodeAccount.layerWith({
    fetch: input.fetch,
    now: input.now,
    tokenRequestTimeoutMs: input.tokenRequestTimeoutMs,
  }).pipe(Layer.provide(store.layer))
  return { promise: Effect.runPromise(effect.pipe(Effect.provide(layer))), store, layer }
}

describe("BharatCode native account", () => {
  test("refreshes under the auth transaction and persists the rotated pair", async () => {
    const requests: Request[] = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return json(200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        token_type: "bearer",
        expires_in: 3600,
      })
    }
    const { promise, store } = run(BharatCodeAccount.use.accessToken(), {
      initial: oauth(),
      fetch,
      now: () => 1_000_000,
    })

    await expect(promise).resolves.toBe("access-new")
    expect(store.read()).toMatchObject({ access: "access-new", refresh: "refresh-new", expires: 4_600_000 })
    expect(requests).toHaveLength(1)
    expect(await requests[0].text()).toContain("grant_type=refresh_token")
  })

  test("retains the prior refresh token when rotation omits one", async () => {
    const { promise, store } = run(BharatCodeAccount.use.accessToken(), {
      initial: oauth(),
      fetch: async () => json(200, { access_token: "access-new", expires_in: 60 }),
      now: () => 5_000,
    })
    await promise
    expect(store.read()).toMatchObject({ access: "access-new", refresh: "refresh-old" })
  })

  test.each(["refresh_token_not_found", "refresh_token_already_used"])(
    "clears terminal refresh failure %s without retrying",
    async (errorCode) => {
      let calls = 0
      const { promise, store } = run(BharatCodeAccount.use.accessToken(), {
        initial: oauth(),
        fetch: async () => {
          calls++
          return json(400, { code: 400, error_code: errorCode, msg: "unstable message" })
        },
      })
      await expect(promise).rejects.toMatchObject({ _tag: "BharatCodeSignInRequired", errorCode })
      expect(store.read()).toBeUndefined()
      expect(calls).toBe(1)
    },
  )

  test("clears a terminal refresh failure reported through the standard code field", async () => {
    let calls = 0
    const { promise, store } = run(BharatCodeAccount.use.accessToken(), {
      initial: oauth(),
      fetch: async () => {
        calls++
        return json(400, { code: "refresh_token_not_found", message: "private upstream detail" })
      },
    })

    await expect(promise).rejects.toMatchObject({
      _tag: "BharatCodeSignInRequired",
      errorCode: "refresh_token_not_found",
      message: "Your BharatCode session is no longer valid. Sign in again.",
    })
    expect(store.read()).toBeUndefined()
    expect(calls).toBe(1)
  })

  test.each([429, 503])("preserves credentials on retriable refresh HTTP %s", async (status) => {
    const current = oauth()
    const { promise, store } = run(BharatCodeAccount.use.accessToken(), {
      initial: current,
      fetch: async () => json(status, { error_code: "unexpected_failure", msg: "temporary" }),
    })
    await expect(promise).rejects.toMatchObject({ _tag: "BharatCodeServiceError", status, retriable: true })
    expect(store.read()).toEqual(current)
  })

  test("never propagates upstream secret-shaped messages or transport causes", async () => {
    const leaked = "Bearer private.access.token refresh_token=private-refresh"
    const service = run(BharatCodeAccount.use.accessToken(), {
      initial: oauth(),
      fetch: async () => json(503, { error_code: "unexpected_failure", msg: leaked }),
    })
    await expect(service.promise).rejects.toMatchObject({
      _tag: "BharatCodeServiceError",
      status: 503,
      errorCode: "unexpected_failure",
      message: "BharatCode token request failed (503).",
    })

    const transport = run(BharatCodeAccount.use.accessToken(), {
      initial: oauth(),
      fetch: async () => {
        throw new Error(leaked)
      },
    })
    const error = await transport.promise.then(
      () => undefined,
      (cause) => cause,
    )
    expect(error).toMatchObject({ _tag: "BharatCodeTransportError" })
    expect(JSON.stringify(error)).not.toContain("private.access.token")
    expect(JSON.stringify(error)).not.toContain("private-refresh")
  })

  test("preserves credentials on a transport failure", async () => {
    const current = oauth()
    const { promise, store } = run(BharatCodeAccount.use.accessToken(), {
      initial: current,
      fetch: async () => {
        throw new TypeError("dns failed")
      },
    })
    await expect(promise).rejects.toMatchObject({ _tag: "BharatCodeTransportError" })
    expect(store.read()).toEqual(current)
  })

  test("aborts a stalled token request, preserves credentials, and releases the auth transaction", async () => {
    const current = oauth()
    let calls = 0
    let aborted = false
    const fetch: BharatCodeAccount.Fetch = async (_input, init) => {
      calls++
      if (calls > 1) {
        return json(200, {
          access_token: "access-after-timeout",
          refresh_token: "refresh-after-timeout",
          expires_in: 3600,
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("test fallback")), 250)
        const signal = init?.signal
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            clearTimeout(fallback)
            reject(new Error("aborted"))
          },
          { once: true },
        )
      })
    }
    const started = performance.now()
    const { promise, store, layer } = run(BharatCodeAccount.use.accessToken(), {
      initial: current,
      fetch,
      tokenRequestTimeoutMs: 20,
    })

    await expect(promise).rejects.toMatchObject({ _tag: "BharatCodeTransportError" })
    expect(performance.now() - started).toBeLessThan(150)
    expect(aborted).toBe(true)
    expect(store.read()).toEqual(current)

    await expect(Effect.runPromise(BharatCodeAccount.use.accessToken().pipe(Effect.provide(layer)))).resolves.toBe(
      "access-after-timeout",
    )
    expect(store.read()).toMatchObject({
      access: "access-after-timeout",
      refresh: "refresh-after-timeout",
    })
  })

  test("keeps the token deadline active until the response body completes", async () => {
    const current = oauth()
    let calls = 0
    let aborted = false
    const fetch: BharatCodeAccount.Fetch = async (_input, init) => {
      calls++
      if (calls > 1) {
        return json(200, {
          access_token: "access-after-body-timeout",
          refresh_token: "refresh-after-body-timeout",
          expires_in: 3600,
        })
      }
      const signal = init?.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":"partial'))
            const fallback = setTimeout(() => controller.error(new Error("test fallback")), 250)
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true
                clearTimeout(fallback)
                controller.error(new Error("aborted"))
              },
              { once: true },
            )
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    const started = performance.now()
    const { promise, store, layer } = run(BharatCodeAccount.use.accessToken(), {
      initial: current,
      fetch,
      tokenRequestTimeoutMs: 20,
    })

    await expect(promise).rejects.toMatchObject({ _tag: "BharatCodeTransportError" })
    expect(performance.now() - started).toBeLessThan(150)
    expect(aborted).toBe(true)
    expect(store.read()).toEqual(current)

    await expect(Effect.runPromise(BharatCodeAccount.use.accessToken().pipe(Effect.provide(layer)))).resolves.toBe(
      "access-after-body-timeout",
    )
  })

  test("refreshes and retries an authenticated request at most once after 401", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    let modelCalls = 0
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push({ url: request.url, authorization: request.headers.get("authorization") })
      if (request.url.endsWith("/oauth/token")) {
        return json(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 })
      }
      modelCalls++
      return modelCalls === 1 ? json(401, { message: "expired" }) : json(200, { ok: true })
    }
    const { promise } = run(
      BharatCodeAccount.use.authenticatedFetch("https://bharatcode.ai/api/model/v1/responses", { method: "POST" }),
      {
        initial: oauth({ expires: 9_999_999 }),
        fetch,
        now: () => 1_000,
      },
    )

    const response = await promise
    expect(response.status).toBe(200)
    expect(modelCalls).toBe(2)
    expect(seen.map((item) => item.authorization)).toEqual(["Bearer access-old", null, "Bearer access-new"])
  })

  test("deduplicates concurrent refreshes after multiple requests receive 401", async () => {
    let tokenCalls = 0
    let oldAccessCalls = 0
    let newAccessCalls = 0
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.endsWith("/oauth/token")) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 10))
        return json(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 })
      }
      if (request.headers.get("authorization") === "Bearer access-old") {
        oldAccessCalls++
        return json(401, { message: "expired" })
      }
      if (request.headers.get("authorization") === "Bearer access-new") {
        newAccessCalls++
        return json(200, { ok: true })
      }
      return json(500, { message: "unexpected token" })
    }
    const { promise } = run(
      Effect.all(
        [
          BharatCodeAccount.use.authenticatedFetch("https://bharatcode.ai/api/model/v1/responses"),
          BharatCodeAccount.use.authenticatedFetch("https://bharatcode.ai/api/model/v1/responses"),
        ],
        { concurrency: "unbounded" },
      ),
      {
        initial: oauth({ expires: 9_999_999 }),
        fetch,
        now: () => 1_000,
      },
    )

    const responses = await promise
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(oldAccessCalls).toBe(2)
    expect(newAccessCalls).toBe(2)
    expect(tokenCalls).toBe(1)
  })

  test("never replays an in-flight request under a newly selected account", async () => {
    let releaseOldRequest!: () => void
    let markOldRequestStarted!: () => void
    const oldRequestStarted = new Promise<void>((resolve) => (markOldRequestStarted = resolve))
    const oldRequestResponse = new Promise<void>((resolve) => (releaseOldRequest = resolve))
    let newAccountModelCalls = 0
    const store = authStore(oauth({ expires: 9_999_999 }))
    const layer = BharatCodeAccount.layerWith({
      now: () => 1_000,
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.url.endsWith("/oauth/token")) {
          return json(200, {
            access_token: "access-account-b",
            refresh_token: "refresh-account-b",
            expires_in: 3600,
          })
        }
        if (request.url.endsWith("/oauth/userinfo")) {
          return json(200, { sub: "user-account-b", email: "account-b@example.com" })
        }
        if (request.headers.get("authorization") === "Bearer access-old") {
          markOldRequestStarted()
          await oldRequestResponse
          return json(401, { message: "expired" })
        }
        if (request.headers.get("authorization") === "Bearer access-account-b") {
          newAccountModelCalls++
          return json(200, { ok: true })
        }
        return json(500, { message: "unexpected request" })
      },
    }).pipe(Layer.provide(store.layer))

    const originalRequest = Effect.runPromise(
      BharatCodeAccount.use
        .authenticatedFetch("https://bharatcode.ai/api/model/v1/responses", { method: "POST" })
        .pipe(Effect.provide(layer)),
    )
    await oldRequestStarted

    await Effect.runPromise(
      Effect.gen(function* () {
        const pending = yield* BharatCodeAccount.use.beginAuthorization({
          redirectUri: "bharatcode://auth/callback",
          selectAccount: true,
        })
        const state = new URL(pending.url).searchParams.get("state")!
        return yield* BharatCodeAccount.use.completeAuthorization(
          `bharatcode://auth/callback?code=account-b-code&state=${encodeURIComponent(state)}`,
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(store.read()).toMatchObject({ accountId: "user-account-b", access: "access-account-b" })

    releaseOldRequest()
    await expect(originalRequest).rejects.toMatchObject({
      _tag: "BharatCodeServiceError",
      operation: "authenticated request",
      status: 409,
      errorCode: "account_changed",
      retriable: false,
    })
    expect(newAccountModelCalls).toBe(0)
    expect(store.read()).toMatchObject({ accountId: "user-account-b", access: "access-account-b" })
  })

  test("a late UserInfo rejection from the old account never removes the newly selected account", async () => {
    let releaseOldIdentity!: () => void
    let markOldIdentityStarted!: () => void
    const oldIdentityStarted = new Promise<void>((resolve) => (markOldIdentityStarted = resolve))
    const oldIdentityResponse = new Promise<void>((resolve) => (releaseOldIdentity = resolve))
    const store = authStore(oauth({ expires: 9_999_999 }))
    const layer = BharatCodeAccount.layerWith({
      now: () => 1_000,
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.url.endsWith("/oauth/token")) {
          const form = new URLSearchParams(await request.text())
          if (form.get("grant_type") === "refresh_token") {
            return json(200, {
              access_token: "access-account-a-refreshed",
              refresh_token: "refresh-account-a-refreshed",
              expires_in: 3600,
            })
          }
          return json(200, {
            access_token: "access-account-b",
            refresh_token: "refresh-account-b",
            expires_in: 3600,
          })
        }
        const authorization = request.headers.get("authorization")
        if (authorization === "Bearer access-old") return json(401, { message: "expired" })
        if (authorization === "Bearer access-account-a-refreshed") {
          markOldIdentityStarted()
          await oldIdentityResponse
          return json(401, { message: "revoked" })
        }
        if (authorization === "Bearer access-account-b") {
          return json(200, { sub: "user-account-b", email: "account-b@example.com" })
        }
        return json(500, { message: "unexpected request" })
      },
    }).pipe(Layer.provide(store.layer))

    const oldIdentity = Effect.runPromise(BharatCodeAccount.use.identity().pipe(Effect.provide(layer)))
    await oldIdentityStarted

    await Effect.runPromise(
      Effect.gen(function* () {
        const pending = yield* BharatCodeAccount.use.beginAuthorization({
          redirectUri: "bharatcode://auth/callback",
          selectAccount: true,
        })
        const state = new URL(pending.url).searchParams.get("state")!
        return yield* BharatCodeAccount.use.completeAuthorization(
          `bharatcode://auth/callback?code=account-b-code&state=${encodeURIComponent(state)}`,
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(store.read()).toMatchObject({ accountId: "user-account-b", access: "access-account-b" })

    releaseOldIdentity()
    await expect(oldIdentity).rejects.toMatchObject({
      _tag: "BharatCodeServiceError",
      operation: "identity request",
      status: 409,
      errorCode: "account_changed",
      retriable: false,
    })
    expect(store.read()).toMatchObject({ accountId: "user-account-b", access: "access-account-b" })
    await expect(Effect.runPromise(BharatCodeAccount.use.status().pipe(Effect.provide(layer)))).resolves.toMatchObject({
      state: "signed-in",
      accountID: "user-account-b",
    })
  })

  test("clears the still-rejected token after one refresh instead of retrying on later requests", async () => {
    let tokenCalls = 0
    let modelCalls = 0
    const { promise, store } = run(
      BharatCodeAccount.use.authenticatedFetch("https://bharatcode.ai/api/model/v1/responses"),
      {
        initial: oauth({ expires: 9_999_999 }),
        now: () => 1_000,
        fetch: async (input) => {
          const url = new URL(input instanceof Request ? input.url : input)
          if (url.pathname.endsWith("/oauth/token")) {
            tokenCalls++
            return json(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 })
          }
          modelCalls++
          return json(401, { message: "still rejected" })
        },
      },
    )

    await expect(promise).rejects.toMatchObject({ _tag: "BharatCodeSignInRequired" })
    expect(store.read()).toBeUndefined()
    expect(tokenCalls).toBe(1)
    expect(modelCalls).toBe(2)
  })

  test("a failed account switch leaves the current account untouched", async () => {
    const current = oauth({ expires: 9_999_999 })
    const fetch = async () => json(503, { error_code: "unexpected_failure" })
    const store = authStore(current)
    const layer = BharatCodeAccount.layerWith({ fetch, now: () => 1_000 }).pipe(Layer.provide(store.layer))
    const program = Effect.gen(function* () {
      const pending = yield* BharatCodeAccount.use.beginAuthorization({
        redirectUri: "bharatcode://auth/callback",
        selectAccount: true,
      })
      const state = new URL(pending.url).searchParams.get("state")!
      return yield* BharatCodeAccount.use.completeAuthorization(
        `bharatcode://auth/callback?code=bad-code&state=${encodeURIComponent(state)}`,
      )
    })

    await expect(Effect.runPromise(program.pipe(Effect.provide(layer)))).rejects.toMatchObject({
      _tag: "BharatCodeServiceError",
      status: 503,
    })
    expect(store.read()).toEqual(current)
  })

  test("commits OAuth only after stable UserInfo identity and rejects callback replay", async () => {
    let calls = 0
    const fetch = async (input: string | URL | Request) => {
      calls++
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname.endsWith("/oauth/token")) {
        return json(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 })
      }
      return json(200, { sub: "stable-user-id", email: "mutable@example.com", name: "Mutable Name" })
    }
    const store = authStore()
    const layer = BharatCodeAccount.layerWith({ fetch, now: () => 10_000 }).pipe(Layer.provide(store.layer))
    let callback = ""
    const first = Effect.gen(function* () {
      const pending = yield* BharatCodeAccount.use.beginAuthorization({ redirectUri: "bharatcode://auth/callback" })
      const state = new URL(pending.url).searchParams.get("state")!
      callback = `bharatcode://auth/callback?code=good-code&state=${encodeURIComponent(state)}`
      return yield* BharatCodeAccount.use.completeAuthorization(callback)
    })

    await expect(Effect.runPromise(first.pipe(Effect.provide(layer)))).resolves.toMatchObject({
      sub: "stable-user-id",
      email: "mutable@example.com",
    })
    expect(store.read()).toMatchObject({ accountId: "stable-user-id", access: "access-new", refresh: "refresh-new" })
    await expect(
      Effect.runPromise(BharatCodeAccount.use.completeAuthorization(callback).pipe(Effect.provide(layer))),
    ).rejects.toMatchObject({ _tag: "BharatCodeOAuthError", reason: "state" })
    expect(calls).toBe(2)
  })

  test("reports a connection problem without logging out during DNS failure", async () => {
    const current = oauth({ expires: 9_999_999 })
    const { promise, store } = run(BharatCodeAccount.use.status(), {
      initial: current,
      fetch: async () => {
        throw new TypeError("offline")
      },
      now: () => 1_000,
    })
    await expect(promise).resolves.toMatchObject({ state: "connection-problem", accountID: "user-old" })
    expect(store.read()).toEqual(current)
  })

  test("reports the committed rotated expiry after status refresh", async () => {
    const { promise } = run(BharatCodeAccount.use.status(), {
      initial: oauth({ expires: 0 }),
      now: () => 1_000,
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.pathname.endsWith("/oauth/token")) {
          return json(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 60 })
        }
        return json(200, { sub: "user-old", email: "safe@example.com" })
      },
    })

    await expect(promise).resolves.toMatchObject({ state: "signed-in", expiresAt: 61_000 })
  })

  test("uses exact registered redirects and S256 PKCE", async () => {
    const store = authStore()
    const layer = BharatCodeAccount.layerWith({ fetch: async () => json(500, {}) }).pipe(Layer.provide(store.layer))
    const begin = (redirectUri: string) =>
      Effect.runPromise(BharatCodeAccount.use.beginAuthorization({ redirectUri }).pipe(Effect.provide(layer)))

    await expect(begin("http://localhost:27182/callback")).rejects.toMatchObject({
      _tag: "BharatCodeOAuthError",
      reason: "redirect",
    })
    await expect(begin("https://example.invalid/callback")).rejects.toMatchObject({
      _tag: "BharatCodeOAuthError",
      reason: "redirect",
    })

    const pending = await begin(BharatCodeAccount.CLI_REDIRECT_URI)
    const url = new URL(pending.url)
    expect(url.origin + url.pathname).toBe(`${BharatCodeAccount.OAUTH_ISSUER}/oauth/authorize`)
    expect(url.searchParams.get("redirect_uri")).toBe(BharatCodeAccount.CLI_REDIRECT_URI)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("never attaches OAuth credentials to a non-BharatCode origin", async () => {
    let calls = 0
    const { promise } = run(BharatCodeAccount.use.authenticatedFetch("https://example.invalid/steal"), {
      initial: oauth({ expires: 9_999_999 }),
      now: () => 1_000,
      fetch: async () => {
        calls++
        return json(200, {})
      },
    })

    await expect(promise).rejects.toMatchObject({
      _tag: "BharatCodeServiceError",
      errorCode: "origin_not_allowed",
    })
    expect(calls).toBe(0)
  })

  test("email changes do not change the stable account identity", async () => {
    let email = "first@example.com"
    const service = run(
      Effect.gen(function* () {
        const first = yield* BharatCodeAccount.use.identity()
        email = "second@example.com"
        const second = yield* BharatCodeAccount.use.identity()
        return { first, second, accountID: yield* BharatCodeAccount.use.accountID() }
      }),
      {
        initial: oauth({ accountId: "stable-user", expires: 9_999_999 }),
        now: () => 1_000,
        fetch: async () => json(200, { sub: "stable-user", email }),
      },
    )

    await expect(service.promise).resolves.toEqual({
      first: {
        sub: "stable-user",
        email: "first@example.com",
        emailVerified: undefined,
        name: undefined,
        picture: undefined,
      },
      second: {
        sub: "stable-user",
        email: "second@example.com",
        emailVerified: undefined,
        name: undefined,
        picture: undefined,
      },
      accountID: "stable-user",
    })
  })

  test("two processes serialize one refresh and both observe the rotated pair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bharatcode-account-refresh-"))
    try {
      const data = path.join(root, "bharatcode-test", "data")
      const auth = path.join(data, "auth.json")
      await fs.mkdir(data, { recursive: true, mode: 0o700 })
      await fs.chmod(data, 0o700)
      await fs.writeFile(
        auth,
        JSON.stringify({
          bharatcode: {
            type: "oauth",
            access: "access-old",
            refresh: "refresh-old",
            expires: 0,
            accountId: "stable-user",
          },
        }),
        { mode: 0o600 },
      )
      await fs.chmod(auth, 0o600)

      const gate = path.join(root, "gate")
      const marker = path.join(root, "refresh-marker")
      const worker = path.join(import.meta.dir, "../fixture/account-refresh-worker.ts")
      const children = [0, 1].map((index) => {
        const ready = path.join(root, `ready-${index}`)
        const output = path.join(root, `output-${index}`)
        return {
          ready,
          output,
          child: Bun.spawn([process.execPath, worker, JSON.stringify({ root, gate, marker, ready, output })], {
            cwd: path.resolve(import.meta.dir, "../.."),
            stdout: "pipe",
            stderr: "pipe",
          }),
        }
      })

      const started = Date.now()
      while (!(await Promise.all(children.map(({ ready }) => Bun.file(ready).exists()))).every(Boolean)) {
        if (Date.now() - started > 15_000) throw new Error("refresh workers did not reach the barrier")
        await Bun.sleep(10)
      }
      await fs.writeFile(gate, "go")

      const results = await Promise.all(
        children.map(async ({ child, output }) => ({
          code: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
          output: await fs.readFile(output, "utf8").catch(() => ""),
        })),
      )
      expect(results).toEqual(results.map(() => ({ code: 0, stdout: "", stderr: "", output: "access-rotated" })))
      expect(await fs.readFile(marker, "utf8")).toBe("refresh-old")
      expect(JSON.parse(await fs.readFile(auth, "utf8"))).toMatchObject({
        bharatcode: { access: "access-rotated", refresh: "refresh-rotated", accountId: "stable-user" },
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
