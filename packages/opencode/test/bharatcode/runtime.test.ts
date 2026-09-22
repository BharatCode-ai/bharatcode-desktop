import { expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { LLM } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { BharatCodeRuntime } from "../../src/bharatcode/runtime"
import { BharatCodeCatalog } from "../../src/bharatcode/catalog"
import { BharatCodeAccount } from "../../src/bharatcode/account"
import { testEffect } from "../lib/effect"

const model: BharatCodeCatalog.Model = {
  id: "current-coder",
  ownedBy: "bharatcode",
  displayName: "Current Coder",
  status: "live",
  modality: "chat",
  endpoint: "/v1/chat/completions",
  protocol: "openai_chat_completions",
  runtime: "fixture",
  metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: true },
  contextWindow: 128000,
  maxOutputTokens: 8192,
}
const base = Layer.mergeAll(
  Layer.mock(BharatCodeCatalog.Service, { list: () => Effect.succeed([model]) }),
  Layer.mock(Config.Service, { entries: () => Effect.succeed([]) }),
  Layer.mock(BharatCodeAccount.Service, { accessToken: () => Effect.succeed("synthetic-protected-token") }),
)
const catalog = BharatCodeRuntime.catalogLayer.pipe(Layer.provideMerge(base))
const it = testEffect(BharatCodeRuntime.modelLayer.pipe(Layer.provideMerge(catalog)))

function session(providerID = "bharatcode", id = model.id) {
  return SessionV2.Info.make({
    id: SessionV2.ID.make("ses_bharatcode_runtime"),
    projectID: ProjectV2.ID.global,
    title: "Fixture",
    cost: 0,
    model: { providerID: ProviderV2.ID.make(providerID), id: ModelV2.ID.make(id) },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/synthetic-project") },
  })
}
it.effect("exposes only catalog-approved models without credentials", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([
      ProviderV2.ID.make("bharatcode"),
    ])
    expect((yield* catalog.model.available()).map((entry) => entry.id)).toEqual([ModelV2.ID.make(model.id)])
    expect(JSON.stringify(yield* catalog.model.all())).not.toContain("synthetic-protected-token")
    expect(JSON.stringify(yield* catalog.provider.all())).not.toContain("apiKey")
    expect(yield* catalog.model.get(ProviderV2.ID.make("openai"), ModelV2.ID.make(model.id))).toBeUndefined()
  }),
)
it.effect("authenticates the native outbound route without putting its token in the JSON body", () =>
  Effect.gen(function* () {
    const resolver = yield* SessionRunnerModel.Service
    const resolved = yield* resolver.resolve(session())
    const request = LLM.request({ model: resolved, prompt: "Synthetic message" })
    const prepared = yield* LLMClient.prepare(request)
    const headers = yield* resolved.route.auth.apply({
      request,
      method: "POST",
      url: BharatCodeAccount.MODEL_API_BASE_URL + "/chat/completions",
      body: "{}",
      headers: Headers.empty,
    })
    expect(headers.authorization).toBe("Bearer synthetic-protected-token")
    expect(resolved.route.endpoint).toMatchObject({ baseURL: BharatCodeAccount.MODEL_API_BASE_URL })
    expect(JSON.stringify(prepared.body)).not.toContain("synthetic-protected-token")
    expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
  }),
)
it.effect("rejects unlisted providers and models instead of falling back", () =>
  Effect.gen(function* () {
    const resolver = yield* SessionRunnerModel.Service
    expect((yield* resolver.resolve(session("openai")).pipe(Effect.flip))._tag).toBe(
      "SessionRunnerModel.ModelUnavailableError",
    )
    expect((yield* resolver.resolve(session("bharatcode", "removed-model")).pipe(Effect.flip))._tag).toBe(
      "SessionRunnerModel.ModelUnavailableError",
    )
  }),
)
it.effect("does not permit plugin transforms to substitute the shipped catalog", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const exit = yield* catalog
      .transform(() => {
        throw new Error("must never execute")
      })
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

const signedOut = testEffect(
  BharatCodeRuntime.catalogLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Config.Service, { entries: () => Effect.succeed([]) }),
        Layer.mock(BharatCodeCatalog.Service, {
          list: () => Effect.fail(new BharatCodeAccount.SignInRequired({ message: "Sign in required" })),
        }),
      ),
    ),
  ),
)
signedOut.effect("a missing account cannot receive a generic or stale catalog", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    expect((yield* catalog.model.available().pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* catalog.provider.available().pipe(Effect.exit))._tag).toBe("Failure")
  }),
)
