import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"

type Input =
  | { mode: "set"; root: string; ready: string; gate: string; key: string; value: string }
  | { mode: "remove"; root: string; ready: string; gate: string; key: string }
  | { mode: "holder"; root: string; ready: string; gate: string; key: string }
  | { mode: "contender"; root: string; ready: string; seen: string; key: string }

const input = JSON.parse(Bun.argv[2] ?? "") as Input
process.env.BHARATCODE_CHANNEL = "test"
process.env.BHARATCODE_TEST_HOME = input.root
delete process.env.OPENCODE_AUTH_CONTENT
delete process.env.BHARATCODE_AUTH_CONTENT

const { Auth } = await import("../../src/auth")
const { Global } = await import("@opencode-ai/core/global")
const { AppFileSystem } = await import("@opencode-ai/core/filesystem")

const base = path.join(input.root, "bharatcode-test")
const data = path.join(base, "data")
const cache = path.join(base, "cache")
const global = Global.layerWith({
  channel: "test",
  home: input.root,
  data,
  cache,
  config: path.join(base, "config"),
  state: path.join(base, "state"),
  tmp: path.join(base, "tmp"),
  bin: path.join(cache, "bin"),
  log: path.join(base, "log"),
  repos: path.join(data, "repos"),
  storage: path.join(data, "storage"),
  auth: path.join(data, "auth.json"),
  database: path.join(data, "bharatcode.db"),
})
let reportedWait = false
const authLayer =
  input.mode === "contender"
    ? Auth.layerWith({
        onLockWait: async () => {
          if (reportedWait) return
          reportedWait = true
          await fs.writeFile(input.ready, "blocked")
        },
      })
    : Auth.layer
const layer = authLayer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(global))

async function waitFor(file: string, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`barrier timed out: ${path.basename(file)}`)
}

await Effect.runPromise(
  Auth.Service.use((auth) => {
    if (input.mode === "set") {
      return Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(input.ready, "ready"))
        yield* Effect.promise(() => waitFor(input.gate))
        yield* auth.set(input.key, { type: "api", key: input.value })
      })
    }
    if (input.mode === "remove") {
      return Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(input.ready, "ready"))
        yield* Effect.promise(() => waitFor(input.gate))
        yield* auth.remove(input.key)
      })
    }
    if (input.mode === "holder") {
      return auth.transaction(input.key, (current) =>
        Effect.gen(function* () {
          if (current?.type !== "oauth" || current.access !== "access-r1") {
            return yield* Effect.die("holder did not read r1")
          }
          yield* Effect.promise(() => fs.writeFile(input.ready, "ready"))
          yield* Effect.promise(() => waitFor(input.gate))
          return {
            action: "set" as const,
            info: { type: "oauth" as const, refresh: "refresh-r2", access: "access-r2", expires: 2 },
            result: undefined,
          }
        }),
      )
    }
    return auth.transaction(input.key, (current) =>
      Effect.gen(function* () {
        if (current?.type !== "oauth") return yield* Effect.die("contender did not read oauth")
        yield* Effect.promise(() => fs.writeFile(input.seen, current.access))
        return { action: "keep" as const, result: undefined }
      }),
    )
  }).pipe(Effect.provide(layer), Effect.scoped),
)
