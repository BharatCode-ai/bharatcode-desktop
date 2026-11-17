import { describe, expect, test } from "bun:test"
import * as ProviderTransform from "@/provider/transform"
import { fromBharatCodeCatalogModel } from "@/provider/provider"
import { toV2Model } from "@/bharatcode/catalog"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

describe("ProviderTransform.message - BharatCode DeepSeek reasoning", () => {
  const catalogModel = {
    id: "deepseek-v4.1-flash",
    displayName: "DeepSeek",
    modality: "chat",
    protocol: "openai_chat_completions",
    ownedBy: "bharatcode",
    endpoint: "/v1/chat/completions",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    created: 0,
    metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: true },
  } as any

  for (const id of ["glm-5.3-flash", "qwen-3.8-27b"]) {
    test(`${id} uses Low by default, accepts High and preserves the 32k wire limit`, async () => {
      const record = { ...catalogModel, id }
      const model = fromBharatCodeCatalogModel(record)!
      const v2 = toV2Model(record)!
      expect(Object.keys(model.variants!)).toEqual(["low", "high"])
      expect(v2.request.variant).toBe("low")
      expect(v2.limit.output).toBe(32000)
      expect(v2.variants.map((variant) => [variant.id, variant.body.reasoning_effort])).toEqual([
        ["low", "low"],
        ["high", "high"],
      ])
      const sent: Record<string, unknown>[] = []
      const sdk = createOpenAICompatible({
        name: "bharatcode",
        baseURL: "https://unused.invalid/v1",
        fetch: Object.assign(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)))
            return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
          },
          { preconnect: () => undefined },
        ),
      })
      for (const variant of [undefined, "low", "high"]) {
        await sdk.chatModel(id).doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
          maxOutputTokens: model.limit.output,
          providerOptions: ProviderTransform.providerOptions(model, {
            ...model.options,
            ...(variant ? model.variants![variant] : {}),
          }),
        })
      }
      expect(sent.map((body) => [body.model, body.reasoning_effort, body.max_tokens])).toEqual([
        [id, "low", 32000],
        [id, "low", 32000],
        [id, "high", 32000],
      ])
    })
  }

  // The OpenAI wire format has no slot for reasoning parts, and DeepSeek expects
  // prior reasoning back as `reasoning_content`. Regression guard: the BharatCode
  // catalog path used to hardcode `interleaved: false`, which stranded it inline.
  test("lifts prior reasoning onto the assistant message", () => {
    const model = fromBharatCodeCatalogModel(catalogModel)!
    const [, assistant] = ProviderTransform.message(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "The user said hi." },
            { type: "text", text: "Hello!" },
          ],
        },
      ] as any,
      model,
      {},
    ) as any[]

    expect(assistant.providerOptions?.openaiCompatible?.reasoning_content).toBe("The user said hi.")
    expect(assistant.content.some((part: any) => part.type === "reasoning")).toBe(false)
    expect(assistant.content.some((part: any) => part.type === "text" && part.text === "Hello!")).toBe(true)
  })
})
