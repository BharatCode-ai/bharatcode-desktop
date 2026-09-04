import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeCatalog } from "@/bharatcode/catalog"

const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"

function accountLayer(input: { accountID?: () => string | undefined; response: () => Promise<Response> }) {
  return Layer.succeed(
    BharatCodeAccount.Service,
    BharatCodeAccount.Service.of({
      accountID: () => Effect.succeed(input.accountID?.()),
      authenticatedFetch: () => Effect.promise(input.response),
      accessToken: () => Effect.die("unused"),
      beginAuthorization: () => Effect.die("unused"),
      completeAuthorization: () => Effect.die("unused"),
      cancelAuthorization: () => Effect.void,
      identity: () => Effect.die("unused"),
      status: () => Effect.die("unused"),
      logout: () => Effect.die("unused"),
    }),
  )
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function run<A, E>(
  effect: Effect.Effect<A, E, BharatCodeCatalog.Service>,
  layer: Layer.Layer<BharatCodeAccount.Service>,
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(BharatCodeCatalog.layerWith({ now: () => 10_000 })), Effect.provide(layer)),
  )
}

describe("BharatCode authenticated catalog", () => {
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
    const models = await run(
      BharatCodeCatalog.use.list(),
      accountLayer({ accountID: () => "account-a", response: async () => response(data) }),
    )
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
      run(
        BharatCodeCatalog.use.list(),
        accountLayer({ accountID: () => "account-a", response: async () => response({ message: "down" }, 503) }),
      ),
    ).rejects.toMatchObject({ _tag: "BharatCodeServiceError", status: 503, retriable: true })
  })

  test("preserves the subscription-required denial from a protected catalog", async () => {
    const failure = await run(
      BharatCodeCatalog.use.list(),
      accountLayer({
        accountID: () => "account-a",
        response: async () =>
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
      }),
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
    const account = accountLayer({
      accountID: () => "account-a",
      response: async () =>
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
              metadata: { output: ["text"] },
            },
          ],
        }),
    })
    const models = await Effect.runPromise(
      BharatCodeCatalog.use
        .list()
        .pipe(
          Effect.provide(BharatCodeCatalog.layerWith({ onDiagnostic: (item) => diagnostics.push(item) })),
          Effect.provide(account),
        ),
    )
    expect(models.map((model) => model.id)).toEqual([CODING_MODEL_ID])
    expect(diagnostics).toEqual([
      {
        reason: "invalid-record",
        fields: ["owned_by", "modality", "endpoint", "display_name", "metadata"],
      },
    ])
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak")
    expect(JSON.stringify(diagnostics)).not.toContain("private.catalog.token")
  })

  test("fails the whole catalog only when the top-level response is malformed", async () => {
    await expect(
      run(
        BharatCodeCatalog.use.list(),
        accountLayer({ accountID: () => "account-a", response: async () => response({ object: "list" }) }),
      ),
    ).rejects.toMatchObject({ _tag: "BharatCodeCatalogError", reason: "contract" })
  })

  test("fails the whole catalog when any valid model ID is duplicated", async () => {
    const layer = accountLayer({
      response: async () =>
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
              metadata: { input: ["text"], output: ["text"] },
            },
            {
              id: "duplicate",
              owned_by: "bharatcode",
              modality: "chat",
              endpoint: "/v1/chat/completions",
              protocol: "openai_chat_completions",
              status: "planned",
              display_name: "Duplicate planned",
              context_window: 128_000,
              max_output_tokens: 32_000,
              metadata: { input: ["text"], output: ["text"] },
            },
          ],
        }),
    })

    await expect(run(BharatCodeCatalog.use.list(), layer)).rejects.toMatchObject({
      _tag: "BharatCodeCatalogError",
      reason: "contract",
    })
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
    })
    expect(BharatCodeCatalog.codingEligibility({ ...chat, maxOutputTokens: 256_000 })).toEqual({
      eligible: false,
      diagnostic: { recordID: CODING_MODEL_ID, reason: "invalid-coding-contract", fields: ["max_output_tokens"] },
    })
    expect(BharatCodeCatalog.codingEligibility({ ...chat, modality: "chat" })).toMatchObject({
      eligible: false,
      diagnostic: { reason: "invalid-coding-contract", fields: ["modality"] },
    })

    for (const id of ["bharatcode:qwen36-35b-q6-256k-vision", "bharatcode:qwen36-35b-q8-256k"]) {
      expect(BharatCodeCatalog.codingEligibility({ ...chat, id })).toEqual({
        eligible: false,
        diagnostic: { recordID: id, reason: "unsupported-coding-model", fields: ["id"] },
      })
      expect(BharatCodeCatalog.toV2Model({ ...chat, id })).toBeUndefined()
    }

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
    })
    expect(BharatCodeCatalog.codingEligibility(dictation)).toMatchObject({
      eligible: false,
      diagnostic: { reason: "not-coding-model" },
    })
  })

  test("deduplicates and caches per stable account identity but not across account switches", async () => {
    let id = "account-a"
    let calls = 0
    const layer = accountLayer({
      accountID: () => id,
      response: async () => {
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
      },
    })
    const catalog = BharatCodeCatalog.layerWith({ now: () => 10_000 })
    const program = Effect.gen(function* () {
      const [first, second] = yield* Effect.all([BharatCodeCatalog.use.list(), BharatCodeCatalog.use.list()], {
        concurrency: 2,
      })
      id = "account-b"
      const third = yield* BharatCodeCatalog.use.list()
      return { first, second, third }
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(catalog), Effect.provide(layer)))
    expect(result.first[0].id).toBe("model-account-a")
    expect(result.second[0].id).toBe("model-account-a")
    expect(result.third[0].id).toBe("model-account-b")
    expect(calls).toBe(2)
  })
})
