import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { BharatCodeAccount } from "./account"
import { BharatCodeCatalog } from "./catalog"

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024
export const MAX_AUDIO_BASE64 = Math.ceil(MAX_AUDIO_BYTES / 3) * 4
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/ogg": "ogg",
  "audio/ogg;codecs=opus": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
}

export class DictationError extends Schema.TaggedErrorClass<DictationError>()("BharatCodeDictationError", {
  reason: Schema.Literals(["invalid_audio", "unavailable", "sign_in", "access"]),
  message: Schema.String,
}) {}
export type Error = DictationError | BharatCodeCatalog.Error
export type Audio = { audio: string; mimeType: string }
export type Transcript = { text: string; language?: string; duration?: number }
export type Status = { available: boolean; maxBytes?: number }
export interface Interface {
  readonly status: () => Effect.Effect<Status, Error>
  readonly transcribe: (input: Audio) => Effect.Effect<Transcript, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/BharatCodeDictation") {}
export const use = serviceUse(Service)

const unavailable = () =>
  new DictationError({ reason: "unavailable", message: "BharatCode dictation is currently unavailable." })
const invalid = () =>
  new DictationError({ reason: "invalid_audio", message: "The dictation recording is invalid or too large." })

export const layerWith = (options: { timeoutMs?: number } = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const catalog = yield* BharatCodeCatalog.Service
      const account = yield* BharatCodeAccount.Service
      const select = Effect.fn("BharatCodeDictation.select")(function* (force = false) {
        const models = yield* catalog.list({ force })
        return models.find(
          (model) => model.ownedBy === "bharatcode" && BharatCodeCatalog.dictationEligibility(model).eligible,
        )
      })
      const limit = (model: BharatCodeCatalog.Model) => Math.min(MAX_AUDIO_BYTES, model.maxInputMb! * 1_000_000)
      const status = Effect.fn("BharatCodeDictation.status")(function* () {
        const model = yield* select()
        return model ? { available: true, maxBytes: limit(model) } : { available: false }
      })
      const transcribe: Interface["transcribe"] = (input) =>
        Effect.suspend(() => {
          const controller = new AbortController()
          return Effect.gen(function* () {
            const extension = Object.hasOwn(MIME_EXTENSIONS, input.mimeType)
              ? MIME_EXTENSIONS[input.mimeType]
              : undefined
            if (!extension || !input.audio.length || input.audio.length > MAX_AUDIO_BASE64) return yield* invalid()
            const bytes = Buffer.from(input.audio, "base64")
            if (bytes.toString("base64") !== input.audio || !bytes.length || bytes.length > MAX_AUDIO_BYTES)
              return yield* invalid()
            const model = yield* select(true)
            if (!model) return yield* unavailable()
            if (bytes.length > limit(model)) return yield* invalid()
            const form = new FormData()
            form.set("model", model.id)
            form.set("response_format", "json")
            form.set("file", new Blob([bytes], { type: input.mimeType }), `dictation.${extension}`)
            const response = yield* account.authenticatedFetch(
              `${BharatCodeAccount.MODEL_API_BASE_URL}/audio/transcriptions`,
              {
                method: "POST",
                body: form,
                signal: controller.signal,
              },
            )
            if (!response.ok) {
              yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve())
              if (response.status === 401)
                return yield* new DictationError({
                  reason: "sign_in",
                  message: "Sign in to BharatCode to use dictation.",
                })
              if (response.status === 402 || response.status === 403)
                return yield* new DictationError({
                  reason: "access",
                  message: "Dictation is not available for this account.",
                })
              return yield* unavailable()
            }
            const value: unknown = yield* Effect.tryPromise({ try: () => response.json(), catch: unavailable })
            if (!value || typeof value !== "object" || Array.isArray(value)) return yield* unavailable()
            const payload = value as Record<string, unknown>
            if (
              typeof payload.text !== "string" ||
              payload.text.length > 100_000 ||
              (payload.language !== undefined &&
                (typeof payload.language !== "string" || payload.language.length > 64)) ||
              (payload.duration !== undefined &&
                (typeof payload.duration !== "number" || !Number.isFinite(payload.duration) || payload.duration < 0))
            )
              return yield* unavailable()
            return {
              text: payload.text.trim(),
              ...(payload.language === undefined ? {} : { language: payload.language as string }),
              ...(payload.duration === undefined ? {} : { duration: payload.duration as number }),
            }
          }).pipe(
            Effect.timeoutOrElse({ duration: options.timeoutMs ?? 60_000, orElse: () => Effect.fail(unavailable()) }),
            Effect.ensuring(Effect.sync(() => controller.abort())),
          )
        })
      return Service.of({ status, transcribe })
    }),
  )

export const layer = layerWith()
export const node = LayerNode.make({ service: Service, layer, deps: [BharatCodeAccount.node, BharatCodeCatalog.node] })
export * as BharatCodeDictation from "./dictation"
