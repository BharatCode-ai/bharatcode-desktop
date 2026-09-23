import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProductPolicy } from "../../../src/product/policy"

const result = await Effect.runPromise(
  ProductPolicy.Service.use((policy) =>
    Effect.succeed({
      selected: ProductPolicy.shippedByDefault(),
      shipped: policy.isShipped,
      externalProvider: policy.allowsProvider("external-fixture"),
    }),
  ).pipe(Effect.provide(LayerNode.compile(ProductPolicy.node))),
)
console.log(JSON.stringify(result))
