import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Capabilities } from "@opencode-ai/core/capabilities"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"

const catalog = Capabilities.catalog.map((item) => ({
  id: item.id,
  name: item.name,
  description: item.description,
  publisher: item.publisher,
  version: item.version,
  category: item.category,
  trust: item.trust as "bundled" | "curated",
  defaultEnabled: item.defaultEnabled === true,
  requiresSetup: item.requiresSetup === true,
  requirements: item.requirements,
  permissions: item.permissions,
}))
const storage = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new ServiceUnavailableError({ message: "Capability state is unavailable. Re-read state before retrying." }),
  })

export const capabilitiesHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.capabilities", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const store = () => Capabilities.store({ data: Global.Path.data, desktop: Flag.OPENCODE_CLIENT === "desktop" })
    return handlers
      .handle("get", () => storage(async () => ({ catalog, state: await store().read() })))
      .handle("change", (ctx) =>
        Effect.gen(function* () {
          if (!catalog.some((item) => item.id === ctx.params.id))
            return yield* new InvalidRequestError({ message: "Unknown BharatCode capability." })
          const state = yield* storage(() => store().change(ctx.params.id, ctx.payload.action))
          yield* config.invalidate()
          // Do not silently interrupt active sessions or claim the existing MCP
          // connections have changed. The client explicitly reloads the runtime.
          return { state, reloadRequired: true as const }
        }),
      )
  }),
)
