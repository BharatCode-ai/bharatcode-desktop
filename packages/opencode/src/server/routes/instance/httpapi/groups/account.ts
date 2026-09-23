import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { DESKTOP_REDIRECT_URI } from "@/bharatcode/account"
import { MAX_AUDIO_BASE64 } from "@/bharatcode/dictation"
import {
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
  UpstreamError,
} from "../errors"
import { Authorization } from "../middleware/authorization"

export const AccountPaths = {
  status: "/account/status",
  authorize: "/account/authorize",
  callback: "/account/callback",
  logout: "/account/logout",
  dictation: "/account/dictation",
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

export const AuthorizeRequest = Schema.Struct({
  redirectUri: Schema.Literal(DESKTOP_REDIRECT_URI),
  selectAccount: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "BharatCodeAuthorizeRequest", parseOptions: { onExcessProperty: "error" } })

export const AuthorizeResponse = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "BharatCodeAuthorizeResponse" })

export const CallbackRequest = Schema.Struct({
  callbackUrl: Schema.String,
}).annotate({ identifier: "BharatCodeCallbackRequest", parseOptions: { onExcessProperty: "error" } })

export const LogoutResponse = Schema.Struct({
  ok: Schema.Literal(true),
}).annotate({ identifier: "BharatCodeLogoutResponse" })

const accountErrors = [InvalidRequestError, UnauthorizedError, UpstreamError, ServiceUnavailableError] as const

export const DictationRequest = Schema.Struct({
  audio: Schema.String.check(Schema.isMaxLength(MAX_AUDIO_BASE64)),
  mimeType: Schema.String.check(Schema.isMaxLength(64)),
}).annotate({ identifier: "BharatCodeDictationRequest", parseOptions: { onExcessProperty: "error" } })
export const DictationResponse = Schema.Struct({
  text: Schema.String,
  language: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "BharatCodeDictationResponse" })
export const DictationStatus = Schema.Struct({
  available: Schema.Boolean,
  maxBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "BharatCodeDictationStatus" })

export const AccountGroup = HttpApiGroup.make("v2.account")
  .add(
    HttpApiEndpoint.get("dictationStatus", AccountPaths.dictation, {
      success: DictationStatus,
      error: [...accountErrors, ForbiddenError],
    }),
  )
  .add(
    HttpApiEndpoint.post("dictation", AccountPaths.dictation, {
      payload: DictationRequest,
      success: DictationResponse,
      error: [...accountErrors, ForbiddenError],
    }),
  )
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
  .middleware(Authorization)

export const AccountApi = HttpApi.make("bharatcode-account").add(AccountGroup)
