// Child process only: runtime endpoint selection must occur before module load.
// All credentials/profile paths are synthetic; reject external fixture origins.
import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, streamText } from "ai"

const origin = process.env.BHARATCODE_API_BASE_URL!
assert.equal(new URL(origin).hostname, "127.0.0.1")
assert.equal(process.env.BHARATCODE_AUTH_URL, origin)
assert.ok(process.env.OPENCODE_TEST_HOME)

const { Auth } = await import("../../src/auth")
const { BharatCodeAccount } = await import("../../src/bharatcode/account")
const { BharatCodeCatalog } = await import("../../src/bharatcode/catalog")
const { BharatCodeDictation } = await import("../../src/bharatcode/dictation")
const { fromBharatCodeCatalogModel } = await import("../../src/provider/provider")

const dependencies = Layer.mergeAll(
  BharatCodeAccount.layerWith().pipe(Layer.provideMerge(Auth.defaultLayer)),
  BharatCodeCatalog.layerWith(),
)
const layer = BharatCodeDictation.layerWith().pipe(Layer.provideMerge(dependencies))
await Effect.runPromise(
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const account = yield* BharatCodeAccount.Service
    const catalog = yield* BharatCodeCatalog.Service
    const dictation = yield* BharatCodeDictation.Service
    const pending = yield* account.beginAuthorization({ redirectUri: BharatCodeAccount.DESKTOP_REDIRECT_URI })
    const authorization = yield* Effect.promise(() => fetch(pending.url, { redirect: "manual" }))
    assert.equal(authorization.status, 302)
    yield* account.completeAuthorization(authorization.headers.get("location")!)
    assert.equal((yield* account.status()).state, "signed-in")
    const selected = yield* catalog.list()
    assert.equal(selected.length, 2) // The response's external model endpoint is excluded.
    const model = selected.find((item) => item.id === "synthetic-coder")!
    assert.equal(BharatCodeAccount.API_BASE_URL, origin)
    assert.equal(BharatCodeCatalog.toV2Provider().api.url, `${origin}/api/model/v1`)
    assert.equal(fromBharatCodeCatalogModel(model)!.api.url, `${origin}/api/model/v1`)
    const provider = createOpenAICompatible({
      name: "bharatcode",
      baseURL: BharatCodeAccount.MODEL_API_BASE_URL,
      apiKey: "bharatcode-native-oauth",
      fetch: Object.assign(
        (input: string | URL | Request, init?: RequestInit) =>
          Effect.runPromise(account.authenticatedFetch(input, init)),
        { preconnect() {} },
      ),
    })
    const completed = yield* Effect.promise(() =>
      generateText({
        model: provider(model.id),
        prompt: "synthetic test",
        maxOutputTokens: 16,
        maxRetries: 0,
      }),
    )
    assert.equal(completed.text, "fixture answer")
    const streamed = yield* Effect.promise(async () => {
      const result = streamText({
        model: provider(model.id),
        prompt: "synthetic stream",
        maxOutputTokens: 16,
        maxRetries: 0,
      })
      let text = ""
      for await (const chunk of result.textStream) text += chunk
      return text
    })
    assert.equal(streamed, "fixture answer")
    assert.deepEqual(
      yield* dictation.transcribe({
        audio: Buffer.from("synthetic-audio").toString("base64"),
        mimeType: "audio/webm",
      }),
      { text: "fixture transcript" },
    )
    const redirected = yield* account.authenticatedFetch(`${origin}/redirect`, { redirect: "follow" })
    assert.equal(redirected.status, 307)
    yield* Effect.promise(() => redirected.body?.cancel() ?? Promise.resolve())
    for (const url of ["https://bharatcode.ai/api/model/v1/chat/completions", "http://localhost:1/unselected"]) {
      const failure = yield* account.authenticatedFetch(url).pipe(Effect.flip)
      assert.equal(failure instanceof BharatCodeAccount.ServiceError && failure.errorCode, "origin_not_allowed")
    }
    const saved = yield* auth.get("bharatcode")
    assert.ok(saved?.type === "oauth")
    const wrongIssuer = `e30.${Buffer.from(JSON.stringify({ iss: "https://wrong.example.test/auth/v1" })).toString("base64url")}.synthetic`
    const changed = new Auth.Oauth({ ...saved, access: wrongIssuer })
    yield* auth.set("bharatcode", changed)
    const failure = yield* account.authenticatedFetch(`${origin}/api/model/v1/chat/completions`).pipe(Effect.flip)
    assert.equal(failure instanceof BharatCodeAccount.SignInRequired && failure.errorCode, "issuer_mismatch")
    assert.deepEqual(yield* auth.get("bharatcode"), changed)
  }).pipe(Effect.provide(layer)),
)
console.log("isolated-auth-catalog-model-stream-dictation-boundaries: passed")
