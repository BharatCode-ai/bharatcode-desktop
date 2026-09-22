import { Deferred, Effect } from "effect"

// The connection is not usable until health succeeds. A failed health check must
// settle the same barrier observed by every window and account operation.
export function initializeConnection<A, E, R>(
  initialization: Deferred.Deferred<A, unknown>,
  connection: A,
  health: Effect.Effect<unknown, E, R>,
) {
  return health.pipe(
    Effect.andThen(Deferred.succeed(initialization, connection)),
    forwardInitializationFailure(initialization),
  )
}

export function forwardInitializationFailure<A>(initialization: Deferred.Deferred<A, unknown>) {
  return <B, E, R>(effect: Effect.Effect<B, E, R>) =>
    effect.pipe(Effect.tapCause((cause) => Deferred.failCause(initialization, cause)))
}
