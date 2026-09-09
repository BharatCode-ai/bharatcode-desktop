import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { DESKTOP_REDIRECT_URI } from "@/bharatcode/account"
import { InvalidRequestError, ServiceUnavailableError, UnauthorizedError, UpstreamError } from "../../errors"
import { V2Authorization } from "../../middleware/authorization"

export const AccountPaths = {
  status: "/account/status",
  authorize: "/account/authorize",
  callback: "/account/callback",
  logout: "/account/logout",
} as const

export const AccountStatusResponse = Schema.Struct({
  state: Schema.Literals(["signed-out", "sign-in-required", "connection-problem", "signed-in"]),
  accountID: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "BharatCodeAccountStatusResponse" })

const AuthorizeRequestShape = Schema.Struct({
  redirectUri: Schema.Literal(DESKTOP_REDIRECT_URI),
  selectAccount: Schema.optional(Schema.Boolean),
})
export const AuthorizeRequest = Schema.Unknown.pipe(
  Schema.check(
    Schema.makeFilter(
      (input) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).every((key) => key === "redirectUri" || key === "selectAccount"),
      { message: "BharatCode authorization request contains unknown fields." },
    ),
  ),
  Schema.decodeTo(AuthorizeRequestShape, {
    decode: SchemaGetter.passthrough({ strict: false }),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "BharatCodeAuthorizeRequest" })

export const AuthorizeResponse = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "BharatCodeAuthorizeResponse" })

const CallbackRequestShape = Schema.Struct({
  callbackUrl: Schema.String,
})
export const CallbackRequest = Schema.Unknown.pipe(
  Schema.check(
    Schema.makeFilter(
      (input) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).every((key) => key === "callbackUrl"),
      { message: "BharatCode callback request contains unknown fields." },
    ),
  ),
  Schema.decodeTo(CallbackRequestShape, {
    decode: SchemaGetter.passthrough({ strict: false }),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "BharatCodeCallbackRequest" })

export const LogoutResponse = Schema.Struct({
  ok: Schema.Literal(true),
}).annotate({ identifier: "BharatCodeLogoutResponse" })

const accountErrors = [InvalidRequestError, UnauthorizedError, UpstreamError, ServiceUnavailableError] as const

export const AccountGroup = HttpApiGroup.make("v2.account")
  .add(
    HttpApiEndpoint.get("status", AccountPaths.status, {
      success: AccountStatusResponse,
      error: ServiceUnavailableError,
    }),
  )
  .add(
    HttpApiEndpoint.post("authorize", AccountPaths.authorize, {
      payload: AuthorizeRequest,
      success: AuthorizeResponse,
      error: accountErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("callback", AccountPaths.callback, {
      payload: CallbackRequest,
      success: AccountStatusResponse,
      error: accountErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("logout", AccountPaths.logout, {
      success: LogoutResponse,
      error: ServiceUnavailableError,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "BharatCode account",
      description: "Sidecar-local BharatCode account status and actions.",
    }),
  )
  .middleware(V2Authorization)
