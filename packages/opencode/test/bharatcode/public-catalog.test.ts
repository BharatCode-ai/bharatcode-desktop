import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BharatCodeCatalog } from "@/bharatcode/catalog"

const payload = { object: "list", data: [] }
const run = (options: BharatCodeCatalog.LayerOptions) =>
  Effect.runPromise(BharatCodeCatalog.use.list().pipe(Effect.provide(BharatCodeCatalog.layerWith(options))))

describe("public model discovery", () => {
  test("needs no account service and sends no credentials to the exact public endpoint", async () => {
    let calls = 0
    expect(
      await run({
        fetch: async (url, init) => {
          calls++
          expect(String(url)).toBe("https://bharatcode.ai/api/model/v1/models")
          expect(init?.method).toBe("GET")
          expect(init?.credentials).toBe("omit")
          expect(init?.redirect).toBe("error")
          expect(new Headers(init?.headers).has("authorization")).toBe(false)
          return Response.json(payload)
        },
      }),
    ).toEqual([])
    expect(calls).toBe(1)
  })

  test("deduplicates public discovery and respects expiry and explicit refresh", async () => {
    let now = 0
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.all([BharatCodeCatalog.use.list(), BharatCodeCatalog.use.list()], { concurrency: 2 })
        expect(calls).toBe(1)
        now = 101
        yield* BharatCodeCatalog.use.list()
        expect(calls).toBe(2)
        yield* BharatCodeCatalog.use.list({ force: true })
        expect(calls).toBe(3)
      }).pipe(
        Effect.provide(
          BharatCodeCatalog.layerWith({
            now: () => now,
            ttlMs: 100,
            fetch: async () => {
              calls++
              return Response.json(payload)
            },
          }),
        ),
      ),
    )
  })

  test("bounds a stalled response body and aborts its request", async () => {
    let signal: AbortSignal | undefined
    await expect(
      run({
        requestTimeoutMs: 10,
        fetch: async (_url, init) => {
          signal = init?.signal ?? undefined
          return new Response(new ReadableStream({ start() {} }))
        },
      }),
    ).rejects.toMatchObject({ _tag: "BharatCodeTransportError" })
    expect(signal?.aborted).toBe(true)
  })

  test("sanitizes transport and malformed response failures", async () => {
    for (const fetch of [
      async () => {
        throw new Error("seeded-private-token")
      },
      async () => new Response("seeded-private-token"),
    ]) {
      const failure = await run({ fetch }).catch((error) => error)
      expect(failure).toBeDefined()
      expect(["BharatCodeTransportError", "BharatCodeCatalogError"]).toContain(failure._tag)
      expect(JSON.stringify(failure)).not.toContain("seeded-private-token")
    }
  })

  test("a public gateway denial is not evidence that the user's session expired", async () => {
    for (const payload of [null, [], { error: { message: "seeded-private-token" } }]) {
      const failure = await run({ fetch: async () => Response.json(payload, { status: 401 }) }).catch((error) => error)
      expect(failure).toMatchObject({ _tag: "BharatCodeServiceError", status: 401 })
      expect(BharatCodeCatalog.modelUnavailableReason(failure)).not.toMatch(/sign in/i)
      expect(JSON.stringify(failure)).not.toContain("seeded-private-token")
    }
  })

  test("a failed refresh is not cached as an empty catalog", async () => {
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* BharatCodeCatalog.use.list().pipe(Effect.result)
        expect(first._tag).toBe("Failure")
        yield* BharatCodeCatalog.use.list()
        expect(calls).toBe(2)
      }).pipe(
        Effect.provide(
          BharatCodeCatalog.layerWith({
            fetch: async () => {
              calls++
              return calls === 1
                ? Response.json({ error: { message: "seeded-private-token" } }, { status: 503 })
                : Response.json(payload)
            },
          }),
        ),
      ),
    )
  })
})
