import { describe, expect, test } from "bun:test"

// @ts-expect-error The bundled JavaScript provider is copied into the packaged app without declarations.
import { BharatCodePlugin } from "../../resources/provider/bharatcode/index.js"

const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"
const CODING_MODEL = `bharatcode/${CODING_MODEL_ID}`

describe("bundled BharatCode provider", () => {
  test("configures every coding role with the one canonical model", async () => {
    const config = {} as {
      model?: string
      small_model?: string
      agent?: Record<string, { model?: string }>
      provider?: Record<string, { models: Record<string, unknown> }>
    }
    const plugin = await BharatCodePlugin(null, { accessToken: "test-token" })

    await plugin.config(config)

    expect(config.model).toBe(CODING_MODEL)
    expect(config.small_model).toBe(CODING_MODEL)
    expect(Object.values(config.agent ?? {}).map((agent) => agent.model)).toEqual([
      CODING_MODEL,
      CODING_MODEL,
      CODING_MODEL,
      CODING_MODEL,
    ])
    expect(Object.keys(config.provider?.bharatcode.models ?? {})).toEqual([CODING_MODEL_ID])
    expect(config.provider?.bharatcode.models[CODING_MODEL_ID]).toMatchObject({
      limit: { context: 200_000, output: 32_000 },
    })
  })

  test.each(["model", "small_model"] as const)(
    "rejects retired %s overrides instead of translating them",
    async (option) => {
      for (const model of [
        "bharatcode/bharatcode:qwen36-35b-q6-256k-vision",
        "bharatcode/bharatcode:qwen36-35b-q8-256k",
      ]) {
        await expect(BharatCodePlugin(null, { accessToken: "test-token", [option]: model })).rejects.toThrow(
          `${CODING_MODEL}. Retired model IDs are not translated.`,
        )
      }
    },
  )
})
