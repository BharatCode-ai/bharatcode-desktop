import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { FSUtil } from "../src/fs-util"
import { RipgrepBinary } from "../src/ripgrep/binary"

async function resolve(body: Uint8Array, status = 200, installed = false) {
  const requests: string[] = []
  let writes = 0
  let extractions = 0
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const base = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...base,
        isFile: () => Effect.succeed(installed),
        ensureDir: () => Effect.void,
        writeWithDirs: () =>
          Effect.sync(() => {
            writes++
          }),
        makeTempDirectoryScoped: () =>
          Effect.sync(() => {
            extractions++
          }).pipe(Effect.andThen(Effect.die(new Error("Unverified archive reached extraction")))),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        return HttpClientResponse.fromWeb(request, new Response(body, { status }))
      }),
    ),
  )
  const layer = LayerNode.compile(RipgrepBinary.node, [
    [FSUtil.node, filesystem],
    [LayerNodePlatform.httpClient, http],
  ])
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const binary = yield* RipgrepBinary.Service
      return yield* binary.filepath.pipe(Effect.exit)
    }).pipe(Effect.provide(layer)),
  )
  return { result, requests, writes, extractions }
}

test("downloaded ripgrep fails closed before writing or extracting mismatched bytes", async () => {
  const output = await resolve(new TextEncoder().encode("not the pinned release archive"))
  expect(Exit.isFailure(output.result)).toBe(true)
  if (!Exit.isFailure(output.result)) throw new Error("Expected checksum rejection")
  expect(Cause.pretty(output.result.cause)).toContain("ripgrep checksum mismatch")
  expect(output.requests).toHaveLength(1)
  expect(output.requests[0]).toStartWith("https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/")
  expect(output.writes).toBe(0)
  expect(output.extractions).toBe(0)
})

test("empty and failed ripgrep responses never reach disk or extraction", async () => {
  for (const [body, status] of [
    [new Uint8Array(), 200],
    [new TextEncoder().encode("not found"), 404],
  ] as const) {
    const output = await resolve(body, status)
    expect(Exit.isFailure(output.result)).toBe(true)
    expect(output.writes).toBe(0)
    expect(output.extractions).toBe(0)
  }
})

test("an already installed ripgrep does not trigger an archive download", async () => {
  const output = await resolve(new Uint8Array(), 200, true)
  expect(Exit.isSuccess(output.result)).toBe(true)
  expect(output.requests).toEqual([])
  expect(output.writes).toBe(0)
  expect(output.extractions).toBe(0)
})
