import { Effect } from "effect"
import { Auth } from "../../src/auth"

// The test preload isolates Global paths. Use the same protected store as the
// runtime instead of unsafe auth.json writes or unsupported environment injection.
export function providerAuth(provider: string, info: Auth.Info) {
  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* Effect.acquireRelease(auth.get(provider).pipe(Effect.tap(() => auth.set(provider, info))), (previous) =>
      (previous ? auth.set(provider, previous) : auth.remove(provider)).pipe(Effect.orDie),
    )
  })
}
