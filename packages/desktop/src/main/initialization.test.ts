import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { initializeConnection } from "./initialization"

test("all windows and account callers wait for real health, including late subscribers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<string, unknown>()
      const health = yield* Deferred.make<void>()
      const task = yield* initializeConnection(ready, "connection", Deferred.await(health)).pipe(Effect.forkChild)
      expect(yield* Deferred.isDone(ready)).toBe(false)
      yield* Deferred.succeed(health, undefined)
      yield* Fiber.join(task)
      expect(yield* Deferred.await(ready)).toBe("connection")
      expect(yield* Deferred.await(ready)).toBe("connection")
    }),
  )
})

test("health failure settles the connection as failure, never success", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<string, unknown>()
      yield* initializeConnection(ready, "connection", Effect.fail("unhealthy")).pipe(Effect.ignore)
      expect(yield* Deferred.isDone(ready)).toBe(true)
      const result = yield* Deferred.await(ready).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
    }),
  )
})
