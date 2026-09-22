import { Effect, Layer } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { BharatCodeAccount } from "./account"
import { BharatCodeCatalog } from "./catalog"
import { ProductPolicy } from "../product/policy"

export const catalogLayer = Layer.effect(
  Catalog.Service,
  Effect.gen(function* () {
    const catalog = yield* BharatCodeCatalog.Service
    const config = yield* Config.Service
    const provider = BharatCodeCatalog.toV2Provider()
    const list = Effect.fn("BharatCodeRuntime.models")(function* (force = false) {
      for (const entry of yield* config.entries()) {
        if (entry.type !== "document") continue
        const error = ProductPolicy.findConfigViolation({
          provider: entry.info.providers,
          plugin: entry.info.plugins,
          model: entry.info.model,
          agent: entry.info.agents,
          command: entry.info.commands,
        })
        if (error) return yield* Effect.die(error)
      }
      return (yield* catalog.list({ force }).pipe(Effect.orDie)).flatMap((entry) => {
        const model = BharatCodeCatalog.toV2Model(entry)
        return model ? [{ ...model, api: { ...provider.api, id: model.api.id } }] : []
      })
    })
    const providers = () => list().pipe(Effect.map(() => [provider]))
    return Catalog.Service.of({
      provider: {
        all: providers,
        available: providers,
        get: (id) => list().pipe(Effect.map(() => (id === provider.id ? provider : undefined))),
      },
      model: {
        all: list,
        available: list,
        get: (providerID, id) =>
          list().pipe(
            Effect.map((models) => models.find((model) => model.providerID === providerID && model.id === id)),
          ),
        default: () =>
          Effect.gen(function* () {
            const models = yield* list()
            const selected = Config.latest(yield* config.entries(), "model")
            return selected ? models.find((model) => `${model.providerID}/${model.id}` === selected) : models[0]
          }),
        small: (providerID) =>
          list().pipe(Effect.map((models) => models.find((model) => model.providerID === providerID))),
      },
      // The shipped catalog is product-managed, never a mutable generic plugin catalog.
      transform: () => Effect.die(ProductPolicy.violation("", "provider_configuration")),
      reload: () => list(true).pipe(Effect.asVoid),
    })
  }),
)

export const modelLayer = Layer.effect(
  SessionRunnerModel.Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const account = yield* BharatCodeAccount.Service
    return SessionRunnerModel.Service.of({
      resolve: Effect.fn("BharatCodeRuntime.resolve")(function* (session) {
        const model = session.model
          ? yield* catalog.model.get(session.model.providerID, session.model.id)
          : yield* catalog.model.default()
        if (!model && session.model)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!model) return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })
        // Resolve the current protected account token for each provider turn. It is
        // held only by the outbound route, never persisted into public catalog data.
        const token = yield* account.accessToken().pipe(Effect.orDie)
        return yield* SessionRunnerModel.resolve(session, model, { type: "key", key: token })
      }),
    })
  }),
)

const catalogNode = LayerNode.make({
  service: Catalog.Service,
  tag: Catalog.node.tag,
  layer: catalogLayer,
  deps: [BharatCodeCatalog.node, Config.node],
})
const modelNode = LayerNode.make({
  service: SessionRunnerModel.Service,
  tag: SessionRunnerModel.node.tag,
  layer: modelLayer,
  deps: [catalogNode, BharatCodeAccount.node],
})

export function replacements(): LayerNode.Replacements {
  if (!ProductPolicy.shippedByDefault()) return []
  return [
    [Catalog.node, catalogNode],
    [SessionRunnerModel.node, modelNode],
    [PluginInternal.node, PluginInternal.nodeWith({ providers: false, external: false })],
  ]
}

export * as BharatCodeRuntime from "./runtime"
