import type { Hooks } from "@opencode-ai/plugin"
import { Context, Effect, Layer, Schema } from "effect"
import { BharatCodeModel } from "@/bharatcode/model"

export const PROVIDER_ID = "bharatcode"

type ModelConfig = { model?: unknown }

export type ProviderConfig = {
  provider?: Record<string, unknown>
  plugin?: readonly unknown[]
  enabled_providers?: readonly string[]
  disabled_providers?: readonly string[]
  model?: unknown
  small_model?: unknown
  agent?: Record<string, ModelConfig | undefined>
  mode?: Record<string, ModelConfig | undefined>
  command?: Record<string, ModelConfig | undefined>
}

export type ViolationSource =
  | "provider_configuration"
  | "enabled_providers"
  | "disabled_providers"
  | "default_model"
  | "small_model"
  | "agent_model"
  | "command_model"
  | "plugin_auth"
  | "plugin_provider"
  | "plugin_specification"
  | "provider_request"

export class ProviderPolicyError extends Schema.TaggedErrorClass<ProviderPolicyError>()(
  "BharatCodeProviderPolicyError",
  {
    code: Schema.Literal("bharatcode_provider_only"),
    source: Schema.Literals([
      "provider_configuration",
      "enabled_providers",
      "disabled_providers",
      "default_model",
      "small_model",
      "agent_model",
      "command_model",
      "plugin_auth",
      "plugin_provider",
      "plugin_specification",
      "provider_request",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const ONLY_BHARATCODE = "BharatCode supports only BharatCode models and accounts."

export function recoveryMessage(source: unknown) {
  if (source === "plugin_specification" || source === "plugin_auth" || source === "plugin_provider") {
    return `${ONLY_BHARATCODE} Remove unsupported plugin entries from \`bharatcode.json\`.`
  }
  if (source === "provider_configuration") {
    return `${ONLY_BHARATCODE} Provider endpoints, packages, credentials, and models are product-managed; remove provider overrides from \`bharatcode.json\`.`
  }
  if (
    source === "default_model" ||
    source === "small_model" ||
    source === "agent_model" ||
    source === "command_model"
  ) {
    return BharatCodeModel.recoveryMessage()
  }
  return `${ONLY_BHARATCODE} Sign in, run \`bharatcode models\`, and remove unsupported provider or model entries from \`bharatcode.json\`.`
}

export function violation(_providerID: string, source: ViolationSource) {
  return new ProviderPolicyError({
    code: "bharatcode_provider_only",
    source,
    message: recoveryMessage(source),
  })
}

function modelProvider(value: unknown) {
  if (typeof value !== "string") return
  return value.split("/", 1)[0]
}

function modelViolation(value: unknown, source: ViolationSource) {
  if (value === undefined) return
  const providerID = modelProvider(value)
  if (!providerID) return
  if (providerID === PROVIDER_ID) return
  return violation(providerID, source)
}

function collectionModelViolation(value: Record<string, ModelConfig | undefined> | undefined, source: ViolationSource) {
  for (const item of Object.values(value ?? {})) {
    const hit = modelViolation(item?.model, source)
    if (hit) return hit
  }
}

export function findConfigViolation(config: ProviderConfig): ProviderPolicyError | undefined {
  for (const providerID of Object.keys(config.provider ?? {})) {
    return violation(providerID, "provider_configuration")
  }

  if (config.plugin?.length) return violation("external", "plugin_specification")

  if (config.enabled_providers) {
    const unsupported = config.enabled_providers.find((providerID) => providerID !== PROVIDER_ID)
    if (unsupported) return violation(unsupported, "enabled_providers")
    if (!config.enabled_providers.includes(PROVIDER_ID)) return violation(PROVIDER_ID, "enabled_providers")
  }

  if (config.disabled_providers?.includes(PROVIDER_ID)) return violation(PROVIDER_ID, "disabled_providers")

  return (
    modelViolation(config.model, "default_model") ??
    modelViolation(config.small_model, "small_model") ??
    collectionModelViolation(config.agent, "agent_model") ??
    collectionModelViolation(config.mode, "agent_model") ??
    collectionModelViolation(config.command, "command_model")
  )
}

export function findHookViolation(hook: Hooks): ProviderPolicyError | undefined {
  if (hook.auth?.provider && hook.auth.provider !== PROVIDER_ID) {
    return violation(hook.auth.provider, "plugin_auth")
  }
  if (hook.provider?.id && hook.provider.id !== PROVIDER_ID) {
    return violation(hook.provider.id, "plugin_provider")
  }
}

export interface Interface {
  readonly isShipped: boolean
  readonly allowsProvider: (providerID: string) => boolean
  readonly assertProvider: (providerID: string) => Effect.Effect<void, ProviderPolicyError>
  readonly assertConfig: (config: ProviderConfig) => Effect.Effect<void, ProviderPolicyError>
  readonly assertHook: (hook: Hooks) => Effect.Effect<void, ProviderPolicyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductPolicy") {}

function make(isShipped: boolean): Interface {
  const allowsProvider = (providerID: string) => !isShipped || providerID === PROVIDER_ID
  return Service.of({
    isShipped,
    allowsProvider,
    assertProvider(providerID) {
      return allowsProvider(providerID) ? Effect.void : Effect.fail(violation(providerID, "provider_request"))
    },
    assertConfig(config) {
      if (!isShipped) return Effect.void
      const hit = findConfigViolation(config)
      return hit ? Effect.fail(hit) : Effect.void
    },
    assertHook(hook) {
      if (!isShipped) return Effect.void
      const hit = findHookViolation(hook)
      return hit ? Effect.fail(hit) : Effect.void
    },
  })
}

export const shippedLayer = Layer.succeed(Service, make(true))
export const genericInternalLayer = Layer.succeed(Service, make(false))
export const defaultLayer = shippedLayer

export * as ProductPolicy from "."
