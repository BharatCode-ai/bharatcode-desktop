import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../../api"
import { ServiceUnavailableError } from "../../errors"

const unavailable = () =>
  new ServiceUnavailableError({ message: "BharatCode model catalog is unavailable", service: "bharatcode" })

export const modelHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.model", (handlers) =>
  Effect.gen(function* () {
    const catalog = yield* BharatCodeCatalog.Service
    return handlers.handle(
      "models",
      Effect.fn(function* () {
        const records = yield* catalog.list().pipe(Effect.mapError(unavailable))
        const result = records.flatMap((record) => {
          const model = BharatCodeCatalog.toV2Model(record)
          return model ? [model] : []
        })
        if (!result.length) return yield* unavailable()
        return result
      }),
    )
  }),
)
