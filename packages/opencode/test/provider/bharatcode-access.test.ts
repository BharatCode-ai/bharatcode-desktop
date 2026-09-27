import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

import { Auth } from "@/auth"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ProductPolicy } from "@/product/policy"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { MODEL_CATALOG_UNAVAILABLE, MODEL_SIGN_IN_REQUIRED } from "@opencode-ai/core/util/model-recovery"

const MESSAGE =
  "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."

const providerLayer = LayerNode.compile(Provider.node, [
  // This file exercises the shipped surface, and a test build is generic by
  // default, so ask for the shipped policy explicitly.
  [ProductPolicy.node, ProductPolicy.shippedLayer],
  [
    BharatCodeCatalog.node,
    Layer.mock(BharatCodeCatalog.Service, {
      list: () =>
        Effect.fail(
          new BharatCodeAccount.ServiceError({
            operation: "model catalog",
            status: 402,
            errorCode: "subscription_required",
            retriable: false,
            message: "BharatCode model catalog is currently unavailable.",
          }),
        ),
    }),
  ],
])

const futureModels: BharatCodeCatalog.Model[] = [
  {
    id: "bharatcode:qwen36-35b-awq-200k",
    ownedBy: "bharatcode",
    modality: "vision_chat",
    endpoint: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    runtime: "vllm",
    status: "live",
    displayName: "Current coder",
    metadata: { input: ["text", "image"], output: ["text"], toolCalling: true, reasoning: true },
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "bharatcode:future-text-coder",
    ownedBy: "bharatcode",
    modality: "chat",
    endpoint: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    runtime: "vllm",
    status: "live",
    displayName: "Future text coder",
    metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  },
  {
    id: "bharatcode:future-heavy-coder",
    ownedBy: "bharatcode",
    modality: "chat",
    endpoint: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    runtime: "vllm",
    status: "live",
    displayName: "Future heavy coder",
    metadata: {
      input: ["text"],
      output: ["text"],
      toolCalling: true,
      reasoning: true,
      accessTier: "heavy",
    },
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "bharatcode:future-embedding",
    ownedBy: "bharatcode",
    modality: "embedding",
    endpoint: "/v1/embeddings",
    protocol: "openai_embeddings",
    runtime: "vllm",
    status: "live",
    displayName: "Embedding service",
    metadata: { input: ["text"], output: ["embedding"] },
  },
]

const futureProviderLayer = LayerNode.compile(Provider.node, [
  // This file exercises the shipped surface, and a test build is generic by
  // default, so ask for the shipped policy explicitly.
  [ProductPolicy.node, ProductPolicy.shippedLayer],
  [BharatCodeCatalog.node, Layer.mock(BharatCodeCatalog.Service, { list: () => Effect.succeed(futureModels) })],
])

const currentProviderLayer = LayerNode.compile(Provider.node, [
  // This file exercises the shipped surface, and a test build is generic by
  // default, so ask for the shipped policy explicitly.
  [ProductPolicy.node, ProductPolicy.shippedLayer],
  [
    BharatCodeCatalog.node,
    Layer.mock(BharatCodeCatalog.Service, { list: () => Effect.succeed(futureModels.slice(0, 1)) }),
  ],
])

const it = testEffect(providerLayer)

it.instance("carries a protected-catalog subscription denial through model lookup", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const failure = yield* provider
      .getModel(ProviderV2.ID.make("bharatcode"), ModelV2.ID.make("bharatcode:qwen36-35b-awq-200k"))
      .pipe(Effect.flip)

    expect(failure).toBeInstanceOf(Provider.ModelNotFoundError)
    expect(failure.reason).toBe(MESSAGE)
    expect(Provider.modelNotFoundMessage(failure)).toBe(MESSAGE)
    expect(Provider.modelNotFoundMessage(failure)).not.toContain("Model not found")
  }),
)

function failingCatalog(error: BharatCodeCatalog.Error) {
  return LayerNode.compile(Provider.node, [
    [ProductPolicy.node, ProductPolicy.shippedLayer],
    [BharatCodeCatalog.node, Layer.mock(BharatCodeCatalog.Service, { list: () => Effect.fail(error) })],
  ])
}

const lookupFailure = Effect.gen(function* () {
  const provider = yield* Provider.Service
  const failure = yield* provider
    .getModel(ProviderV2.ID.make("bharatcode"), ModelV2.ID.make("deepseek-v4.1-flash"))
    .pipe(Effect.flip)
  expect(failure).toBeInstanceOf(Provider.ModelNotFoundError)
  return Provider.modelNotFoundMessage(failure)
})

// A catalog that fails to load leaves no models; the lookup must say why rather
// than claim a model that exists was "not found".
testEffect(
  failingCatalog(
    new BharatCodeAccount.ServiceError({
      operation: "model catalog",
      status: 503,
      retriable: true,
      message: "BharatCode model catalog is currently unavailable.",
    }),
  ),
).instance("explains an unreachable catalog instead of reporting the model as not found", () =>
  Effect.gen(function* () {
    const message = yield* lookupFailure
    expect(message).toBe(MODEL_CATALOG_UNAVAILABLE)
    expect(message).not.toContain("Model not found")
  }),
)

testEffect(failingCatalog(new BharatCodeAccount.SignInRequired({ message: "expired" }))).instance(
  "asks for sign-in when the catalog load needs a fresh session",
  () =>
    Effect.gen(function* () {
      const message = yield* lookupFailure
      expect(message).toBe(MODEL_SIGN_IN_REQUIRED)
      expect(message).toContain("bharatcode auth login")
    }),
)

testEffect(futureProviderLayer).instance("lists and resolves every eligible live catalog model without aliases", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const listed = yield* provider.list()
    const models = listed[ProviderV2.ID.make("bharatcode")].models

    expect(Object.keys(models).sort()).toEqual([
      "bharatcode:future-heavy-coder",
      "bharatcode:future-text-coder",
      "bharatcode:qwen36-35b-awq-200k",
    ])
    expect(models).not.toHaveProperty("bharatcode:future-embedding")
    const future = yield* provider.getModel(
      ProviderV2.ID.make("bharatcode"),
      ModelV2.ID.make("bharatcode:future-text-coder"),
    )
    expect(String(future.id)).toBe("bharatcode:future-text-coder")
    expect(future.capabilities).toMatchObject({
      temperature: false,
      reasoning: false,
      toolcall: true,
      attachment: false,
    })
    const heavy = yield* provider.getModel(
      ProviderV2.ID.make("bharatcode"),
      ModelV2.ID.make("bharatcode:future-heavy-coder"),
    )
    expect(String(heavy.id)).toBe("bharatcode:future-heavy-coder")
  }),
)

testEffect(currentProviderLayer).instance(
  "keeps exactly today's sole catalog model without compatibility aliases",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const listed = yield* provider.list()

      expect(Object.keys(listed[ProviderV2.ID.make("bharatcode")].models)).toEqual(["bharatcode:qwen36-35b-awq-200k"])
    }),
)
