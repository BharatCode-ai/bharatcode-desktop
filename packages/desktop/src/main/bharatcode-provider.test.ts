import { describe, expect, test } from "bun:test"

// @ts-expect-error The bundled JavaScript provider is copied into the packaged app without declarations.
import { BharatCodePlugin } from "../../resources/provider/bharatcode/index.js"

const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"
const CODING_MODEL = `bharatcode/${CODING_MODEL_ID}`

const catalog = [
  {
    id: CODING_MODEL_ID,
    owned_by: "bharatcode",
    modality: "vision_chat",
    endpoint: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    status: "live",
    display_name: "Current coder",
    context_window: 200_000,
    max_output_tokens: 32_000,
    metadata: { input: ["text", "image"], output: ["text"], toolCalling: true, reasoning: true },
  },
  {
    id: "bharatcode:future-text-coder",
    owned_by: "bharatcode",
    modality: "chat",
    endpoint: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    status: "live",
    display_name: "Future text coder",
    context_window: 128_000,
    max_output_tokens: 16_000,
    metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
  },
  {
    id: "bharatcode:embedding-service",
    owned_by: "bharatcode",
    modality: "embedding",
    endpoint: "/v1/embeddings",
    protocol: "openai_embeddings",
    status: "live",
    display_name: "Embedding",
    metadata: { input: ["text"], output: ["embedding"] },
  },
]

function options(overrides = {}) {
  return {
    accessToken: "test-token",
    fetchImpl: async () => Response.json({ object: "list", data: catalog }),
    ...overrides,
  }
}

describe("bundled BharatCode provider", () => {
  test("configures every eligible catalog model while keeping the current default", async () => {
    const config = {} as {
      model?: string
      small_model?: string
      agent?: Record<string, { model?: string }>
      provider?: Record<string, { models: Record<string, unknown> }>
    }
    const plugin = await BharatCodePlugin(null, options())

    await plugin.config(config)

    expect(config.model).toBe(CODING_MODEL)
    expect(config.small_model).toBe(CODING_MODEL)
    expect(Object.values(config.agent ?? {}).map((agent) => agent.model)).toEqual([
      CODING_MODEL,
      CODING_MODEL,
      CODING_MODEL,
      CODING_MODEL,
    ])
    expect(Object.keys(config.provider?.bharatcode.models ?? {})).toEqual([
      CODING_MODEL_ID,
      "bharatcode:future-text-coder",
    ])
    expect(config.provider?.bharatcode.models[CODING_MODEL_ID]).toMatchObject({
      reasoning: true,
      temperature: false,
      tool_call: true,
      attachment: true,
      limit: { context: 200_000, output: 32_000 },
    })
    expect(config.provider?.bharatcode.models["bharatcode:future-text-coder"]).toMatchObject({
      reasoning: false,
      temperature: false,
      tool_call: true,
      attachment: false,
    })
    expect(config.agent?.build).not.toHaveProperty("temperature")
    expect(config.agent?.plan).not.toHaveProperty("temperature")
    expect(config.agent?.title).not.toHaveProperty("temperature")
    expect(config.agent?.compaction).not.toHaveProperty("temperature")
  })

  test.each(["model", "small_model"] as const)(
    "rejects retired %s overrides instead of translating them",
    async (option) => {
      for (const model of [
        "bharatcode/bharatcode:qwen36-35b-q6-256k-vision",
        "bharatcode/bharatcode:qwen36-35b-q8-256k",
      ]) {
        const plugin = await BharatCodePlugin(null, options({ [option]: model }))
        await expect(plugin.config({})).rejects.toThrow("authenticated catalog")
      }
    },
  )

  test("rejects stale BharatCode config fields without partially mutating config", async () => {
    const ids = [
      "bharatcode:qwen36-35b-q6-256k-vision",
      "bharatcode:qwen36-35b-q8-256k",
      "bharatcode:embed-small-v1",
      "bharatcode:unknown-coding-model",
    ]

    for (const field of ["model", "small_model"] as const) {
      for (const id of ids) {
        for (const value of [id, `bharatcode/${id}`]) {
          const config = {
            [field]: value,
            unrelated: { provider: "external", enabled: true },
            provider: { external: { models: { existing: {} } } },
          }
          const before = JSON.stringify(config)
          const plugin = await BharatCodePlugin(null, options())

          await expect(plugin.config(config)).rejects.toThrow("authenticated catalog")
          expect(JSON.stringify(config)).toBe(before)
        }
      }
    }
  })

  test("is idempotent for canonical existing config fields", async () => {
    const config = { model: CODING_MODEL, small_model: CODING_MODEL }
    const plugin = await BharatCodePlugin(null, options())

    await plugin.config(config)

    expect(config.model).toBe(CODING_MODEL)
    expect(config.small_model).toBe(CODING_MODEL)
  })

  test("accepts a future eligible catalog model without a provider update", async () => {
    const future = "bharatcode/bharatcode:future-text-coder"
    const config = {}
    const plugin = await BharatCodePlugin(null, options({ model: future, small_model: future }))

    await plugin.config(config)

    expect(config).toMatchObject({ model: future, small_model: future })
  })

  test("excludes malformed duplicate records without erasing a valid sibling", async () => {
    const malformedDuplicate = {
      ...catalog[1],
      metadata: { input: ["text", 42], output: ["text"], toolCalling: true, reasoning: false },
    }
    const plugin = await BharatCodePlugin(
      null,
      options({
        fetchImpl: async () => Response.json({ object: "list", data: [catalog[0], catalog[1], malformedDuplicate] }),
      }),
    )
    const config = {}

    await plugin.config(config)

    expect(Object.keys(config.provider?.bharatcode.models ?? {})).toEqual([
      CODING_MODEL_ID,
      "bharatcode:future-text-coder",
    ])
  })

  test("excludes malformed complete-looking records while retaining two valid future models", async () => {
    const future = { ...catalog[1], id: "bharatcode:future-heavy-coder", display_name: "Future heavy coder" }
    const malformed = [
      { ...catalog[1], id: "bad id with spaces" },
      { ...catalog[1], id: "bharatcode:cafe\u0301" },
      { ...catalog[1], id: " bharatcode:untrimmed" },
      { ...catalog[1], id: "bharatcode:mixed-output", metadata: { ...catalog[1].metadata, output: ["text", 42] } },
      {
        ...catalog[1],
        id: "bharatcode:missing-reasoning",
        metadata: { input: ["text"], output: ["text"], toolCalling: true },
      },
      {
        ...catalog[1],
        id: "bharatcode:nonboolean-tool",
        metadata: { ...catalog[1].metadata, toolCalling: "yes" },
      },
    ]
    const plugin = await BharatCodePlugin(
      null,
      options({
        fetchImpl: async () => Response.json({ object: "list", data: [catalog[0], catalog[1], future, ...malformed] }),
      }),
    )
    const config = {} as {
      provider?: Record<string, { models: Record<string, unknown> }>
    }

    await plugin.config(config)

    expect(Object.keys(config.provider?.bharatcode.models ?? {})).toEqual([
      CODING_MODEL_ID,
      "bharatcode:future-text-coder",
      "bharatcode:future-heavy-coder",
    ])
  })

  test("rejects duplicate eligible model IDs as catalog ambiguity", async () => {
    const plugin = await BharatCodePlugin(
      null,
      options({ fetchImpl: async () => Response.json({ object: "list", data: [catalog[0], { ...catalog[0] }] }) }),
    )

    await expect(plugin.config({})).rejects.toThrow("catalog is unavailable")
  })

  test("preserves prior handling for unrelated provider config", async () => {
    const config = { model: "external/model", unrelated: { keep: true } }
    const plugin = await BharatCodePlugin(null, options())

    await plugin.config(config)

    expect(config.model).toBe(CODING_MODEL)
    expect(config.unrelated).toEqual({ keep: true })
  })

  test("surfaces the fixed subscription-required message without trusting server copy", async () => {
    const plugin = await BharatCodePlugin(null, {
      accessToken: "test-token",
      fetchImpl: async () =>
        Response.json(
          { error: { type: "subscription_required", message: "seeded private server text" } },
          { status: 402 },
        ),
    })

    await expect(plugin.config({})).rejects.toThrow(
      "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai.",
    )
  })
})
