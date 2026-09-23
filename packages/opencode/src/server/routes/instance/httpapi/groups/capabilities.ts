import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"

export const CapabilityState = Schema.Struct({
  version: Schema.Literal(1),
  installed: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
}).annotate({ identifier: "BharatCodeCapabilityState" })

export const CapabilityCatalogItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  publisher: Schema.String,
  version: Schema.String,
  category: Schema.String,
  trust: Schema.Literals(["bundled", "curated", "local"]),
  defaultEnabled: Schema.Boolean,
  requiresSetup: Schema.Boolean,
  requirements: Schema.Array(Schema.String),
  permissions: Schema.Array(Schema.String),
}).annotate({ identifier: "BharatCodeCapabilityCatalogItem" })

export const CapabilitySnapshot = Schema.Struct({
  catalog: Schema.Array(CapabilityCatalogItem),
  state: CapabilityState,
  configuration: Schema.optional(
    Schema.Struct({
      scope: Schema.Literal("runtime-defaults"),
      entries: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean, custom: Schema.Boolean })),
    }),
  ),
}).annotate({ identifier: "BharatCodeCapabilitySnapshot" })
export const CapabilityChange = Schema.Struct({
  action: Schema.Literals(["install", "enable", "disable", "uninstall"]),
}).annotate({ identifier: "BharatCodeCapabilityChange", parseOptions: { onExcessProperty: "error" } })

export const CapabilitiesApi = HttpApi.make("bharatcode-capabilities").add(
  HttpApiGroup.make("v2.capabilities")
    .add(HttpApiEndpoint.get("get", "/capabilities", { success: CapabilitySnapshot, error: ServiceUnavailableError }))
    .add(
      HttpApiEndpoint.post("change", "/capabilities/:id", {
        params: { id: Schema.String.check(Schema.isMaxLength(64)) },
        payload: CapabilityChange,
        success: Schema.Struct({ state: CapabilityState, reloadRequired: Schema.Literal(true) }),
        error: [InvalidRequestError, ServiceUnavailableError],
      }),
    )
    .middleware(Authorization),
)
