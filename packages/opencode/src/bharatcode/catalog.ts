import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { serviceUse } from "@/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { BharatCodeAccount } from "./account"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DateTime } from "effect"
import { BharatCodeModel } from "./model"

const CATALOG_URL = `${BharatCodeAccount.MODEL_API_BASE_URL}/models`
const DEFAULT_TTL_MS = 300_000

export type Model = {
  id: string
  ownedBy: string
  modality: string
  endpoint: string
  protocol?: string
  runtime?: string
  status: "live"
  displayName: string
  created?: number
  metadata: Record<string, unknown>
  contextWindow?: number
  maxOutputTokens?: number
  maxInputMb?: number
}

export type Diagnostic = {
  recordID?: string
  reason: "invalid-record" | "not-live" | "not-coding-model" | "invalid-coding-contract" | "invalid-dictation-contract"
  fields: readonly string[]
}

export type Eligibility =
  | {
      eligible: true
      input: readonly string[]
      output: readonly string[]
      toolCalling: boolean
      reasoning: boolean
    }
  | { eligible: false; diagnostic: Diagnostic }

export class CatalogError extends Schema.TaggedErrorClass<CatalogError>()("BharatCodeCatalogError", {
  reason: Schema.Literals(["response", "contract"]),
  message: Schema.String,
}) {}

export type Error = BharatCodeAccount.Error | CatalogError

export interface Interface {
  readonly list: (options?: { force?: boolean }) => Effect.Effect<readonly Model[], Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BharatCodeCatalog") {}

export const use = serviceUse(Service)

export type LayerOptions = {
  now?: () => number
  ttlMs?: number
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

type Cache = {
  accountID: string
  expiresAt: number
  models: readonly Model[]
}

function stringField(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined
}

function serviceErrorCode(value: Record<string, unknown>) {
  const nested = value.error && typeof value.error === "object" && !Array.isArray(value.error) ? value.error : undefined
  if (!nested) return stringField(value.error_code) ?? stringField(value.code)
  const error = nested as Record<string, unknown>
  return (
    stringField(value.error_code) ??
    stringField(value.code) ??
    stringField(error.error_code) ??
    stringField(error.code) ??
    stringField(error.type)
  )
}

export function modelUnavailableReason(error: unknown) {
  if (!(error instanceof BharatCodeAccount.ServiceError)) return
  if (!BharatCodeModel.isAccessRequired("bharatcode", error.status, error.errorCode)) return
  return BharatCodeModel.ACCESS_REQUIRED_MESSAGE
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function strictModelID(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || value !== value.normalize("NFC")) return undefined
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : undefined
}

function safeRecordID(value: unknown) {
  if (typeof value !== "string" || !value.length) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) return undefined
  if (/(?:bearer|token|secret|password|credential|api.?key)/i.test(value)) return undefined
  return value
}

function invalidRecord(input: Record<string, unknown>, fields: string[]): Diagnostic {
  return {
    ...(safeRecordID(input.id) ? { recordID: safeRecordID(input.id) } : {}),
    reason: "invalid-record",
    fields,
  }
}

function parseModel(value: unknown): { model?: Model; diagnostic?: Diagnostic } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { diagnostic: { reason: "invalid-record", fields: ["record"] } }
  }
  const input = value as Record<string, unknown>
  const id = strictModelID(input.id)
  const ownedBy = stringField(input.owned_by)
  const modality = stringField(input.modality)
  const endpoint = stringField(input.endpoint)
  const displayName = stringField(input.display_name)
  const status = stringField(input.status)
  const metadata = input.metadata
  const fields = [
    ...(!id ? ["id"] : []),
    ...(!ownedBy ? ["owned_by"] : []),
    ...(!modality ? ["modality"] : []),
    ...(!endpoint ? ["endpoint"] : []),
    ...(!displayName ? ["display_name"] : []),
    ...(!status ? ["status"] : []),
    ...(!metadata || typeof metadata !== "object" || Array.isArray(metadata) ? ["metadata"] : []),
  ]
  if (fields.length) return { diagnostic: invalidRecord(input, fields) }
  if (status !== "live") {
    return {
      diagnostic: {
        recordID: id,
        reason: "not-live",
        fields: ["status"],
      },
    }
  }
  const model: Model = {
    id: id!,
    ownedBy: ownedBy!,
    modality: modality!,
    endpoint: endpoint!,
    protocol: stringField(input.protocol),
    runtime: stringField(input.runtime),
    status,
    displayName: displayName!,
    created: typeof input.created === "number" && Number.isSafeInteger(input.created) ? input.created : undefined,
    metadata: metadata as Record<string, unknown>,
    contextWindow: positiveInteger(input.context_window),
    maxOutputTokens: positiveInteger(input.max_output_tokens),
    maxInputMb: positiveInteger(input.max_input_mb),
  }
  if (model.modality === "chat" || model.modality === "vision_chat") {
    const eligibility = codingEligibility(model)
    if (!eligibility.eligible) return { diagnostic: eligibility.diagnostic }
  }
  if (model.modality === "audio_transcription") {
    const eligibility = dictationEligibility(model)
    if (!eligibility.eligible) return { diagnostic: eligibility.diagnostic }
  }
  return { model }
}

function modalities(model: Model, key: "input" | "output") {
  const value = model.metadata[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return
  return value as readonly string[]
}

function exclusion(model: Model, reason: Diagnostic["reason"], fields: string[]): Eligibility {
  return { eligible: false, diagnostic: { recordID: model.id, reason, fields } }
}

export function codingEligibility(model: Model): Eligibility {
  if (model.modality !== "chat" && model.modality !== "vision_chat") {
    return exclusion(model, "not-coding-model", ["modality"])
  }
  if (model.protocol !== "openai_chat_completions") {
    return exclusion(model, "invalid-coding-contract", ["protocol"])
  }
  const input = modalities(model, "input")
  const output = modalities(model, "output")
  const toolCalling = model.metadata.toolCalling
  const reasoning = model.metadata.reasoning
  const fields = [
    ...(!strictModelID(model.id) ? ["id"] : []),
    ...(model.ownedBy !== "bharatcode" ? ["owned_by"] : []),
    ...(model.endpoint !== "/v1/chat/completions" ? ["endpoint"] : []),
    ...(!model.contextWindow ? ["context_window"] : []),
    ...(!model.maxOutputTokens || (model.contextWindow && model.maxOutputTokens > model.contextWindow)
      ? ["max_output_tokens"]
      : []),
    ...(!input || !input.includes("text") || (model.modality === "vision_chat" && !input.includes("image"))
      ? ["metadata.input"]
      : []),
    ...(!output || !output.includes("text") ? ["metadata.output"] : []),
    ...(typeof toolCalling !== "boolean" ? ["metadata.toolCalling"] : []),
    ...(typeof reasoning !== "boolean" ? ["metadata.reasoning"] : []),
  ]
  return fields.length
    ? exclusion(model, "invalid-coding-contract", fields)
    : {
        eligible: true,
        input: input!,
        output: output!,
        toolCalling: toolCalling as boolean,
        reasoning: reasoning as boolean,
      }
}

export function dictationEligibility(model: Model): Eligibility {
  if (model.modality !== "audio_transcription") {
    return exclusion(model, "invalid-dictation-contract", ["modality"])
  }
  const input = modalities(model, "input")
  const output = modalities(model, "output")
  const fields = [
    ...(model.protocol !== "openai_audio_transcriptions" ? ["protocol"] : []),
    ...(model.endpoint !== "/v1/audio/transcriptions" ? ["endpoint"] : []),
    ...(!model.maxInputMb ? ["max_input_mb"] : []),
    ...(!input || !input.includes("audio") ? ["metadata.input"] : []),
    ...(!output || !output.includes("text") ? ["metadata.output"] : []),
  ]
  return fields.length
    ? exclusion(model, "invalid-dictation-contract", fields)
    : { eligible: true, input: input!, output: output!, toolCalling: false, reasoning: false }
}

const v2ProviderID = ProviderV2.ID.make("bharatcode")
const v2Endpoint = { type: "openai/completions" as const, url: BharatCodeAccount.MODEL_API_BASE_URL }
const v2Options = { headers: {}, body: {}, aisdk: { provider: {}, request: {} } }

export function toV2Provider() {
  return new ProviderV2.Info({
    id: v2ProviderID,
    name: "BharatCode",
    enabled: { via: "account", service: "bharatcode" },
    env: [],
    endpoint: v2Endpoint,
    options: v2Options,
  })
}

export function toV2Model(model: Model) {
  const eligibility = codingEligibility(model)
  if (!eligibility.eligible) return
  const media = (values: readonly string[]) =>
    values.flatMap((value) => (value === "text" || value === "image" ? [`${value}/*`] : []))
  return new ModelV2.Info({
    id: ModelV2.ID.make(model.id),
    apiID: ModelV2.ID.make(model.id),
    providerID: v2ProviderID,
    name: model.displayName,
    endpoint: v2Endpoint,
    capabilities: {
      tools: eligibility.toolCalling,
      input: media(eligibility.input),
      output: media(eligibility.output),
    },
    options: v2Options,
    variants: [],
    time: { released: DateTime.makeUnsafe((model.created ?? 0) * 1000) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.contextWindow!, output: model.maxOutputTokens! },
  })
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const now = options.now ?? Date.now
      const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
      const lock = Semaphore.makeUnsafe(1)
      let cache: Cache | undefined

      const diagnostic = (item: Diagnostic) => {
        options.onDiagnostic?.(item)
        Log.Default.warn("BharatCode catalog record excluded", {
          record_id: item.recordID,
          reason: item.reason,
          fields: item.fields,
        })
      }

      const fetchCatalog = Effect.fn("BharatCodeCatalog.fetch")(function* () {
        const response = yield* account.authenticatedFetch(CATALOG_URL)
        if (!response.ok) {
          const value = yield* Effect.promise(() =>
            response.json().then(
              (item) => item as Record<string, unknown>,
              () => ({}) as Record<string, unknown>,
            ),
          )
          if (response.status === 401) {
            return yield* new BharatCodeAccount.SignInRequired({
              message: "Your BharatCode session is no longer valid. Sign in again.",
            })
          }
          return yield* new BharatCodeAccount.ServiceError({
            operation: "model catalog",
            status: response.status,
            errorCode: serviceErrorCode(value),
            retriable: response.status === 429 || response.status >= 500,
            message: "BharatCode model catalog is currently unavailable.",
          })
        }

        const payload = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () =>
            new CatalogError({ reason: "response", message: "BharatCode model catalog response was not JSON." }),
        })
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return yield* new CatalogError({ reason: "contract", message: "BharatCode model catalog was invalid." })
        }
        const root = payload as Record<string, unknown>
        const data = root.data
        if (root.object !== "list" || !Array.isArray(data)) {
          return yield* new CatalogError({ reason: "contract", message: "BharatCode model catalog had no model list." })
        }
        const result: Model[] = []
        for (const item of data) {
          const parsed = parseModel(item)
          if (parsed.diagnostic) diagnostic(parsed.diagnostic)
          if (parsed.model) result.push(parsed.model)
        }
        const ids = result.map((model) => model.id)
        if (new Set(ids).size !== ids.length) {
          return yield* new CatalogError({ reason: "contract", message: "BharatCode model catalog had duplicate IDs." })
        }
        return result as readonly Model[]
      })

      const list: Interface["list"] = (input = {}) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const accountID = yield* account.accountID()
            if (!input.force && accountID && cache?.accountID === accountID && cache.expiresAt > now()) {
              return cache.models
            }
            const models = yield* fetchCatalog()
            if (accountID) cache = { accountID, expiresAt: now() + ttlMs, models }
            else cache = undefined
            return models
          }),
        )

      return Service.of({ list })
    }),
  )

export const layer = layerWith()
export const defaultLayer = layer.pipe(Layer.provide(BharatCodeAccount.defaultLayer))

export * as BharatCodeCatalog from "./catalog"
