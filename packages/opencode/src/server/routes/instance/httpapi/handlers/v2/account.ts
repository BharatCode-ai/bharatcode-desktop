import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BharatCodeAccount } from "@/bharatcode/account"
import { InstanceHttpApi } from "../../api"
import { InvalidRequestError, ServiceUnavailableError, UnauthorizedError, UpstreamError } from "../../errors"

function mapAccountError<A, R>(effect: Effect.Effect<A, BharatCodeAccount.Error, R>) {
  return effect.pipe(
    Effect.catchTags({
      AuthError: () =>
        Effect.fail(new ServiceUnavailableError({ message: "BharatCode account storage is unavailable." })),
      BharatCodeOAuthError: () =>
        Effect.fail(new InvalidRequestError({ message: "BharatCode authorization was not accepted." })),
      BharatCodeSignInRequired: () =>
        Effect.fail(new UnauthorizedError({ message: "Sign in to BharatCode to continue." })),
      BharatCodeTransportError: () =>
        Effect.fail(new ServiceUnavailableError({ message: "BharatCode is unreachable right now." })),
      BharatCodeServiceError: (error) =>
        Effect.fail(
          error.retriable
            ? new ServiceUnavailableError({ message: "BharatCode is temporarily unavailable." })
            : new UpstreamError({
                message: "BharatCode rejected the account operation.",
                service: "account",
                status: error.status,
              }),
        ),
    }),
  )
}

const mapStorageError = <A, R>(effect: Effect.Effect<A, { readonly _tag: "AuthError" }, R>) =>
  effect.pipe(
    Effect.mapError(() => new ServiceUnavailableError({ message: "BharatCode account storage is unavailable." })),
  )

export const accountHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.account", (handlers) =>
  Effect.gen(function* () {
    const account = yield* BharatCodeAccount.Service
    return handlers
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
