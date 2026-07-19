import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../../api"
import { ProviderNotFoundError, ServiceUnavailableError } from "../../errors"

const unavailable = () =>
  new ServiceUnavailableError({ message: "BharatCode model catalog is unavailable", service: "bharatcode" })

const models = Effect.fn("BharatCodeHttpApi.models")(function* () {
  const catalog = yield* BharatCodeCatalog.Service
  const records = yield* catalog.list().pipe(Effect.mapError(unavailable))
  const result = records.flatMap((record) => {
    const model = BharatCodeCatalog.toV2Model(record)
    return model ? [model] : []
  })
  if (!result.length) return yield* unavailable()
  return result
})

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "providers",
        Effect.fn(function* () {
          yield* models()
          return [BharatCodeCatalog.toV2Provider()]
        }),
      )
      .handle(
        "provider",
        Effect.fn(function* (ctx) {
          if (ctx.params.providerID !== "bharatcode") {
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: "BharatCode supports only provider 'bharatcode'.",
            })
          }
          yield* models()
          return BharatCodeCatalog.toV2Provider()
        }),
      )
  }),
)
