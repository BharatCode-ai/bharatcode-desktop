import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { Auth } from "../../src/auth"
import {
  MODEL_SIGN_IN_REQUIRED,
  MODEL_CATALOG_UNAVAILABLE,
  MODEL_STORAGE_UNAVAILABLE,
} from "@opencode-ai/core/util/model-recovery"

const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function run<A, E>(
  effect: Effect.Effect<A, E, BharatCodeCatalog.Service>,
  fetch: BharatCodeCatalog.LayerOptions["fetch"],
) {
  return Effect.runPromise(effect.pipe(Effect.provide(BharatCodeCatalog.layerWith({ now: () => 10_000, fetch }))))
}

describe("BharatCode public catalog", () => {
  test("catalog failures preserve actionable reasons without exposing payloads", () => {
    const secret = "seeded-token https://private.example/path"
    expect(BharatCodeCatalog.modelUnavailableReason(new BharatCodeAccount.SignInRequired({ message: secret }))).toBe(
      MODEL_SIGN_IN_REQUIRED,
    )
    expect(
      BharatCodeCatalog.modelUnavailableReason(
        new Auth.AuthError({ operation: "read", reason: "permission", message: secret }),
      ),
    ).toBe(MODEL_STORAGE_UNAVAILABLE)
    for (const error of [
      new BharatCodeAccount.TransportError({ operation: "catalog", message: secret }),
      new BharatCodeAccount.ServiceError({ operation: "catalog", status: 503, retriable: true, message: secret }),
      new BharatCodeCatalog.CatalogError({ reason: "contract", message: secret }),
      new Error(secret),
    ])
      expect(BharatCodeCatalog.modelUnavailableReason(error)).toBe(MODEL_CATALOG_UNAVAILABLE)
  })
  test("keeps only live records and preserves explicit coding limits", async () => {
    const data = {
      object: "list",
      data: [
        {
          id: CODING_MODEL_ID,
          object: "model",
          created: 0,
          owned_by: "bharatcode",
          modality: "vision_chat",
          endpoint: "/v1/chat/completions",
          protocol: "openai_chat_completions",
          runtime: "vllm",
          status: "live",
          display_name: "BharatCode Coder",
          context_window: 200_000,
          max_output_tokens: 32_000,
          metadata: { input: ["text", "image"], output: ["text"], toolCalling: true, reasoning: true },
        },
        {
          id: "future-model",
          object: "model",
          created: 0,
          owned_by: "bharatcode",
          modality: "chat",
          endpoint: "/v1/chat/completions",
          protocol: "openai_chat_completions",
          runtime: "vllm",
          status: "planned",
          display_name: "Future",
          context_window: 100_000,
          max_output_tokens: 8_192,
          metadata: {},
        },
      ],
    }
    const models = await run(BharatCodeCatalog.use.list(), async () => response(data))
    expect(models).toEqual([
      expect.objectContaining({
        id: CODING_MODEL_ID,
        status: "live",
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      }),
    ])
  })

  test("does not synthesize a catalog when the endpoint fails", async () => {
    await expect(
      run(BharatCodeCatalog.use.list(), async () => response({ message: "down" }, 503)),
    ).rejects.toMatchObject({ _tag: "BharatCodeServiceError", status: 503, retriable: true })
  })

  test("preserves the subscription-required denial from a protected catalog", async () => {
    const failure = await run(BharatCodeCatalog.use.list(), async () =>
      response(
        {
          error: {
            message: "seeded server text must not define the client contract",
            type: "subscription_required",
            code: "subscription_required",
          },
        },
        402,
      ),
    ).then(
      () => undefined,
      (error) => error,
    )

    expect(failure).toMatchObject({
      _tag: "BharatCodeServiceError",
      status: 402,
      errorCode: "subscription_required",
      retriable: false,
    })
    expect(BharatCodeCatalog.modelUnavailableReason(failure)).toBe(
      "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai.",
    )
  })

  test("excludes an invalid individual record without erasing valid records", async () => {
    const diagnostics: BharatCodeCatalog.Diagnostic[] = []
    const fetch = async () =>
      response({
        object: "list",
        data: [
          { id: "Bearer private.catalog.token", status: "live", secret: "must-not-leak" },
          {
            id: CODING_MODEL_ID,
            owned_by: "bharatcode",
            modality: "chat",
            endpoint: "/v1/chat/completions",
            protocol: "openai_chat_completions",
            runtime: "vllm",
            status: "live",
            display_name: "Valid Chat",
            context_window: 128_000,
            max_output_tokens: 32_000,
            metadata: { input: ["text"], output: ["text"], toolCalling: false, reasoning: false },
          },
        ],
      })
    const models = await Effect.runPromise(
      BharatCodeCatalog.use
        .list()
        .pipe(Effect.provide(BharatCodeCatalog.layerWith({ fetch, onDiagnostic: (item) => diagnostics.push(item) }))),
    )
    expect(models.map((model) => model.id)).toEqual([CODING_MODEL_ID])
    expect(diagnostics).toEqual([
      {
        reason: "invalid-record",
        fields: ["id", "owned_by", "modality", "endpoint", "display_name", "metadata"],
      },
    ])
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak")
    expect(JSON.stringify(diagnostics)).not.toContain("private.catalog.token")
  })

  test("excludes malformed complete-looking coding records without erasing valid siblings", async () => {
    const valid = {
      id: "bharatcode:future-heavy-coder",
      owned_by: "bharatcode",
      modality: "chat",
      endpoint: "/v1/chat/completions",
      protocol: "openai_chat_completions",
      runtime: "vllm",
      status: "live",
      display_name: "Future heavy coder",
      context_window: 256_000,
      max_output_tokens: 32_000,
      metadata: { input: ["text"], output: ["text"], toolCalling: false, reasoning: true },
    }
    const malformed = [
      { ...valid, id: "bad id with spaces" },
      { ...valid, id: "bharatcode:cafe\u0301" },
      { ...valid, id: " bharatcode:untrimmed" },
      { ...valid, id: "bharatcode:mixed-input", metadata: { ...valid.metadata, input: ["text", 42] } },
      { ...valid, id: "bharatcode:missing-tool", metadata: { input: ["text"], output: ["text"], reasoning: true } },
      {
        ...valid,
        id: "bharatcode:nonboolean-reasoning",
        metadata: { ...valid.metadata, reasoning: "yes" },
      },
    ]

    const models = await run(BharatCodeCatalog.use.list(), async () =>
      response({ object: "list", data: [valid, ...malformed] }),
    )

    expect(models.map((model) => model.id)).toEqual([valid.id])
    expect(BharatCodeCatalog.toV2Model(models[0])).toMatchObject({
      id: valid.id,
      capabilities: { tools: false },
      limit: { context: 256_000, output: 32_000 },
    })
  })

  test("fails the whole catalog only when the top-level response is malformed", async () => {
    await expect(run(BharatCodeCatalog.use.list(), async () => response({ object: "list" }))).rejects.toMatchObject({
      _tag: "BharatCodeCatalogError",
      reason: "contract",
    })
  })

  test("fails the whole catalog only when an eligible valid model ID is duplicated", async () => {
    const fetch = async () =>
      response({
        object: "list",
        data: [
          {
            id: "duplicate",
            owned_by: "bharatcode",
            modality: "chat",
            endpoint: "/v1/chat/completions",
            protocol: "openai_chat_completions",
            status: "live",
            display_name: "Duplicate",
            context_window: 128_000,
            max_output_tokens: 32_000,
            metadata: { input: ["text"], output: ["text"], toolCalling: false, reasoning: false },
          },
          {
            id: "duplicate",
            owned_by: "bharatcode",
            modality: "chat",
            endpoint: "/v1/chat/completions",
            protocol: "openai_chat_completions",
            status: "live",
            display_name: "Duplicate eligible",
            context_window: 128_000,
            max_output_tokens: 32_000,
            metadata: { input: ["text"], output: ["text"], toolCalling: false, reasoning: false },
          },
        ],
      })

    await expect(run(BharatCodeCatalog.use.list(), fetch)).rejects.toMatchObject({
      _tag: "BharatCodeCatalogError",
      reason: "contract",
    })
  })

  test("does not treat a malformed duplicate as catalog ambiguity", async () => {
    const valid = {
      id: "bharatcode:valid-sibling",
      owned_by: "bharatcode",
      modality: "chat",
      endpoint: "/v1/chat/completions",
      protocol: "openai_chat_completions",
      status: "live",
      display_name: "Valid sibling",
      context_window: 128_000,
      max_output_tokens: 32_000,
      metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
    }
    const models = await run(BharatCodeCatalog.use.list(), async () =>
      response({
        object: "list",
        data: [valid, { ...valid, metadata: { input: ["text", 42], output: ["text"] } }],
      }),
    )

    expect(models.map((model) => model.id)).toEqual([valid.id])
  })

  test("defines shared fail-closed coding and dictation eligibility", () => {
    const chat: BharatCodeCatalog.Model = {
      id: CODING_MODEL_ID,
      ownedBy: "bharatcode",
      modality: "vision_chat",
      endpoint: "/v1/chat/completions",
      protocol: "openai_chat_completions",
      runtime: "vllm",
      status: "live",
      displayName: "Chat",
      metadata: { input: ["text", "image"], output: ["text"], toolCalling: true, reasoning: true },
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    }
    expect(BharatCodeCatalog.codingEligibility(chat)).toEqual({
      eligible: true,
      input: ["text", "image"],
      output: ["text"],
      toolCalling: true,
      reasoning: true,
    })
    expect(BharatCodeCatalog.codingEligibility({ ...chat, maxOutputTokens: 256_000 })).toEqual({
      eligible: false,
      diagnostic: { recordID: CODING_MODEL_ID, reason: "invalid-coding-contract", fields: ["max_output_tokens"] },
    })
    expect(BharatCodeCatalog.codingEligibility({ ...chat, modality: "chat" })).toEqual({
      eligible: true,
      input: ["text", "image"],
      output: ["text"],
      toolCalling: true,
      reasoning: true,
    })

    const futureChat = {
      ...chat,
      id: "bharatcode:future-text-coder",
      modality: "chat",
      displayName: "Future text coder",
      metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
    }
    expect(BharatCodeCatalog.codingEligibility(futureChat)).toEqual({
      eligible: true,
      input: ["text"],
      output: ["text"],
      toolCalling: true,
      reasoning: false,
    })
    expect(BharatCodeCatalog.toV2Model(futureChat)).toMatchObject({
      id: "bharatcode:future-text-coder",
      limit: { context: 128_000, output: 16_000 },
    })

    expect(BharatCodeCatalog.codingEligibility({ ...futureChat, maxOutputTokens: 256_000 })).toMatchObject({
      eligible: false,
      diagnostic: { reason: "invalid-coding-contract", fields: ["max_output_tokens"] },
    })

    const dictation: BharatCodeCatalog.Model = {
      ...chat,
      id: "speech",
      modality: "audio_transcription",
      endpoint: "/v1/audio/transcriptions",
      protocol: "openai_audio_transcriptions",
      metadata: { input: ["audio"], output: ["text"] },
      contextWindow: undefined,
      maxOutputTokens: undefined,
      maxInputMb: 100,
    }
    expect(BharatCodeCatalog.dictationEligibility(dictation)).toEqual({
      eligible: true,
      input: ["audio"],
      output: ["text"],
      toolCalling: false,
      reasoning: false,
    })
    expect(BharatCodeCatalog.codingEligibility(dictation)).toMatchObject({
      eligible: false,
      diagnostic: { reason: "not-coding-model" },
    })
  })

  test("refreshes public model metadata only on expiry or force", async () => {
    let id = "catalog-a"
    let calls = 0
    const fetch = async () => {
      calls++
      return response({
        object: "list",
        data: [
          {
            id: `model-${id}`,
            object: "model",
            created: 0,
            owned_by: "bharatcode",
            modality: "audio_transcription",
            endpoint: "/v1/audio/transcriptions",
            protocol: "openai_audio_transcriptions",
            runtime: "nemo",
            status: "live",
            display_name: "Speech",
            max_input_mb: 100,
            metadata: { input: ["audio"], output: ["text"] },
          },
        ],
      })
    }
    const catalog = BharatCodeCatalog.layerWith({ now: () => 10_000, fetch })
    const program = Effect.gen(function* () {
      const [first, second] = yield* Effect.all([BharatCodeCatalog.use.list(), BharatCodeCatalog.use.list()], {
        concurrency: 2,
      })
      id = "catalog-b"
      const cached = yield* BharatCodeCatalog.use.list()
      const third = yield* BharatCodeCatalog.use.list({ force: true })
      return { first, second, cached, third }
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(catalog)))
    expect(result.first[0].id).toBe("model-catalog-a")
    expect(result.second[0].id).toBe("model-catalog-a")
    expect(result.cached[0].id).toBe("model-catalog-a")
    expect(result.third[0].id).toBe("model-catalog-b")
    expect(calls).toBe(2)
  })
})
