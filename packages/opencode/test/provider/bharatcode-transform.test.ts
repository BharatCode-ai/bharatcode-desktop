import { describe, expect, test } from "bun:test"
import * as ProviderTransform from "@/provider/transform"
import { fromBharatCodeCatalogModel } from "@/provider/provider"

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
