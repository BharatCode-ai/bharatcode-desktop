import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeDictation } from "@/bharatcode/dictation"
import { InstanceHttpApi } from "../api"
import {
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
  UpstreamError,
} from "../errors"

function mapDictationError<A, R>(effect: Effect.Effect<A, BharatCodeDictation.Error, R>) {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error._tag === "BharatCodeCatalogError")
        return new ServiceUnavailableError({ message: "BharatCode dictation is currently unavailable." })
      if (error._tag !== "BharatCodeDictationError") return accountError(error)
      if (error.reason === "invalid_audio") return new InvalidRequestError({ message: error.message })
      if (error.reason === "sign_in") return new UnauthorizedError({ message: error.message })
      if (error.reason === "access") return new ForbiddenError({ message: error.message })
      return new ServiceUnavailableError({ message: error.message })
    }),
  )
}

function accountError(error: BharatCodeAccount.Error) {
  if (error._tag === "AuthError")
    return new ServiceUnavailableError({ message: "BharatCode account storage is unavailable." })
  if (error._tag === "BharatCodeOAuthError")
    return new InvalidRequestError({ message: "BharatCode authorization was not accepted." })
  if (error._tag === "BharatCodeSignInRequired")
    return new UnauthorizedError({ message: "Sign in to BharatCode to continue." })
  if (error._tag === "BharatCodeTransportError")
    return new ServiceUnavailableError({ message: "BharatCode is unreachable right now." })
  return error.retriable
    ? new ServiceUnavailableError({ message: "BharatCode is temporarily unavailable." })
    : new UpstreamError({
        message: "BharatCode rejected the account operation.",
        service: "account",
        status: error.status,
      })
}

function mapAccountError<A, R>(effect: Effect.Effect<A, BharatCodeAccount.Error, R>) {
  return effect.pipe(Effect.mapError(accountError))
}

const mapStorageError = <A, R>(effect: Effect.Effect<A, { readonly _tag: "AuthError" }, R>) =>
  effect.pipe(
    Effect.mapError(() => new ServiceUnavailableError({ message: "BharatCode account storage is unavailable." })),
  )

export const accountHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.account", (handlers) =>
  Effect.gen(function* () {
    const account = yield* BharatCodeAccount.Service
    const dictation = yield* BharatCodeDictation.Service
    return handlers
      .handle("dictationStatus", () => mapDictationError(dictation.status()))
      .handle("dictation", (ctx) => mapDictationError(dictation.transcribe(ctx.payload)))
      .handle("status", () => mapStorageError(account.status()))
      .handle("authorize", (ctx) =>
        mapAccountError(
          account.beginAuthorization({
            redirectUri: ctx.payload.redirectUri,
            selectAccount: ctx.payload.selectAccount,
          }),
        ).pipe(Effect.map(({ url, expiresAt }) => ({ url, expiresAt }))),
      )
      .handle("callback", (ctx) =>
        mapAccountError(account.completeAuthorization(ctx.payload.callbackUrl)).pipe(
          Effect.flatMap(() => mapStorageError(account.status())),
        ),
      )
      .handle("logout", () => mapStorageError(account.logout()).pipe(Effect.as({ ok: true as const })))
  }),
)
