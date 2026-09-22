import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { ProductPolicy } from "@/product/policy"
import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { BharatCodeModel } from "@/bharatcode/model"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

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
    expect(
      ProductPolicy.findConfigViolation({
        model: "bharatcode/bharatcode:future-text-coder",
        small_model: "bharatcode/bharatcode:future-small-coder",
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

  test("delegates BharatCode model membership to the authenticated catalog", () => {
    expect(BharatCodeModel.recoveryMessage()).toContain("authenticated catalog")
    expect(BharatCodeModel.recoveryMessage()).not.toContain(CODING_MODEL_ID)
  })

  test("renders a catalog access denial instead of inventing a missing model", () => {
    const message =
      "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."
    const error = new Provider.ModelNotFoundError({
      providerID: ProviderV2.ID.make("bharatcode"),
      modelID: ModelV2.ID.make(CODING_MODEL_ID),
      reason: message,
    })

    expect(Provider.modelNotFoundMessage(error)).toBe(message)
    expect(Provider.modelNotFoundMessage(error)).not.toContain("Model not found")
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
    expect(
      Provider.fromBharatCodeCatalogModel({
        ...base,
        id: "bharatcode:future-text-coder",
        modality: "chat",
        metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
      }),
    ).toMatchObject({ id: "bharatcode:future-text-coder", limit: { context: 128_000, output: 16_000 } })
  })

  // Shipped v2 isolation is exercised behaviorally in bharatcode/runtime.test.ts
  // and server/httpapi-account.test.ts, rather than scanning obsolete route paths.

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

describe("shipped policy is decided by the build channel", () => {
  // Deciding this from the channel rather than the layer graph is what lets
  // upstream's provider, session and agent suites run against the generic
  // catalog without threading a policy layer through their compositions.
  test.each([
    ["beta", true],
    ["prod", true],
    ["latest", true],
  ] as const)("a packaged %s build is shipped", (channel, expected) => {
    expect(ProductPolicy.shippedByDefault({ BHARATCODE_CHANNEL: channel })).toBe(expected)
  })

  test("a local or test build is internal, so it gets the generic catalog", () => {
    expect(ProductPolicy.shippedByDefault({})).toBe(false)
  })

  test("BHARATCODE_PRODUCT_POLICY forces either surface from any build", () => {
    expect(ProductPolicy.shippedByDefault({ BHARATCODE_PRODUCT_POLICY: "shipped" })).toBe(true)
    expect(ProductPolicy.shippedByDefault({ BHARATCODE_PRODUCT_POLICY: "generic" })).toBe(false)
  })
})
