import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { ProductPolicy } from "@/product/policy"
import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { BharatCodeModel } from "@/bharatcode/model"
import { Provider } from "@/provider/provider"

const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"
const CODING_MODEL = `bharatcode/${CODING_MODEL_ID}`

describe("BharatCode shipped provider policy", () => {
  test("accepts only BharatCode provider configuration and model references", () => {
    expect(
      ProductPolicy.findConfigViolation({
        enabled_providers: ["bharatcode"],
        model: CODING_MODEL,
        small_model: CODING_MODEL,
        agent: { build: { model: CODING_MODEL } },
        command: { review: { model: CODING_MODEL } },
      }),
    ).toBeUndefined()
  })

  test.each([
    [{ provider: { anthropic: {} } }, "provider_configuration"],
    [{ provider: { bharatcode: { api: "https://third-party.invalid" } } }, "provider_configuration"],
    [{ plugin: ["external-plugin@1.0.0"] }, "plugin_specification"],
    [{ enabled_providers: ["bharatcode", "openai"] }, "enabled_providers"],
    [{ enabled_providers: [] }, "enabled_providers"],
    [{ disabled_providers: ["bharatcode"] }, "disabled_providers"],
    [{ model: "openai/gpt-5" }, "default_model"],
    [{ small_model: "anthropic/claude" }, "small_model"],
    [{ agent: { build: { model: "google/gemini" } } }, "agent_model"],
    [{ mode: { plan: { model: "openrouter/model" } } }, "agent_model"],
    [{ command: { review: { model: "mistral/model" } } }, "command_model"],
    [{ model: "bharatcode/bharatcode:qwen36-35b-q6-256k-vision" }, "default_model"],
    [{ small_model: "bharatcode/bharatcode:qwen36-35b-q8-256k" }, "small_model"],
  ])("rejects unsupported config %#", (config, source) => {
    expect(ProductPolicy.findConfigViolation(config)).toMatchObject({ source })
    expect(ProductPolicy.findConfigViolation(config)).not.toHaveProperty("providerID")
  })

  test("does not reject entries that only disable an unsupported provider", () => {
    expect(ProductPolicy.findConfigViolation({ disabled_providers: ["anthropic"] })).toBeUndefined()
  })

  test.each([
    [{ auth: { provider: "openai", methods: [] } }, "plugin_auth"],
    [{ provider: { id: "github-copilot" } }, "plugin_provider"],
  ])("rejects other-provider plugin hooks %#", (hook, source) => {
    expect(ProductPolicy.findHookViolation(hook as Hooks)).toMatchObject({ source })
    expect(ProductPolicy.findHookViolation(hook as Hooks)).not.toHaveProperty("providerID")
  })

  test("accepts provider-independent hooks and BharatCode hooks", () => {
    expect(ProductPolicy.findHookViolation({ tool: {} })).toBeUndefined()
    expect(ProductPolicy.findHookViolation({ auth: { provider: "bharatcode", methods: [] } })).toBeUndefined()
    expect(ProductPolicy.findHookViolation({ provider: { id: "bharatcode" } })).toBeUndefined()
  })

  test("produces a clear fail-closed error", () => {
    const error = ProductPolicy.violation("openai", "provider_configuration")
    expect(error._tag).toBe("BharatCodeProviderPolicyError")
    expect(error.message).toContain("only BharatCode")
    expect(error.message).toContain("remove provider overrides")
    expect(error.message).not.toContain("openai")
  })

  test("names the sole supported model without translating retired IDs", () => {
    const error = ProductPolicy.findConfigViolation({
      model: "bharatcode/bharatcode:qwen36-35b-q6-256k-vision",
    })

    expect(error?.message).toContain(CODING_MODEL)
    expect(error?.message).toContain("not translated")
    expect(BharatCodeModel.rejection("bharatcode:qwen36-35b-q8-256k")).toEqual({
      suggestions: [CODING_MODEL_ID],
      reason: BharatCodeModel.recoveryMessage(),
    })
    expect(BharatCodeModel.rejection(CODING_MODEL_ID)).toBeUndefined()
  })

  test("maps only eligible live BharatCode records into the coding runtime", () => {
    const base: BharatCodeCatalog.Model = {
      id: CODING_MODEL_ID,
      ownedBy: "bharatcode",
      modality: "vision_chat",
      endpoint: "/v1/chat/completions",
      protocol: "openai_chat_completions",
      runtime: "vllm",
      status: "live",
      displayName: "Coding Live",
      metadata: { input: ["text", "image"], output: ["text"], toolCalling: true, reasoning: true },
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    }
    expect(Provider.fromBharatCodeCatalogModel(base)).toMatchObject({
      id: CODING_MODEL_ID,
      providerID: "bharatcode",
      api: { url: "https://bharatcode.ai/api/model/v1" },
      limit: { context: 200_000, output: 32_000 },
    })
    expect(Provider.fromBharatCodeCatalogModel({ ...base, protocol: "openai_responses" })).toBeUndefined()
    expect(Provider.fromBharatCodeCatalogModel({ ...base, id: "bharatcode:qwen36-35b-q6-256k-vision" })).toBeUndefined()
  })

  test("keeps shipped command and v2 query sources free of generic public fallbacks", async () => {
    const source = await Promise.all(
      [
        "../../src/cli/cmd/models.ts",
        "../../src/index.ts",
        "../../src/server/routes/instance/httpapi/handlers/v2/provider.ts",
        "../../src/server/routes/instance/httpapi/handlers/v2/model.ts",
        "../../src/server/mdns.ts",
        "../../src/cli/network.ts",
      ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
    ).then((files) => files.join("\n"))

    expect(source).not.toMatch(/ProvidersCommand|cmd\/providers|models\.dev|ModelsDev|PluginBoot|opencode\.local/)
    expect(source).toContain("BharatCodeCatalog")
  })

  test.each([
    ["file:///home/private/project/plugin.ts?token=shsec_seeded-private-value", "plugin_specification"],
    ["eyJwcml2YXRlX2hlYWRlciI.eyJwcml2YXRlX3BheWxvYWQiOiJzZWVkZWQifQ.private-signature", "provider_request"],
  ] as const)("never serializes untrusted policy identifiers from %s", (privateID, source) => {
    const error = ProductPolicy.violation(privateID, source)
    const rendered = [error.message, String(error), JSON.stringify(error)].join("\n")

    expect(rendered).not.toContain(privateID)
    expect(error).not.toHaveProperty("providerID")
    expect(error.message).toContain("only BharatCode")
  })
})
