import path from "node:path"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const input = JSON.parse(await Bun.stdin.text()) as { root: string; action: string }
if (!path.isAbsolute(input.root) || !path.basename(input.root).startsWith("bc-compiled-auth-"))
  throw new Error("Synthetic root required")
const data = path.join(input.root, "data")
const cache = path.join(input.root, "cache")
const layer = Auth.layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(
    Global.layerWith({
      channel: "test",
      home: input.root,
      data,
      cache,
      config: path.join(input.root, "config"),
      state: path.join(input.root, "state"),
      tmp: path.join(input.root, "tmp"),
      bin: path.join(cache, "bin"),
      log: path.join(input.root, "log"),
      repos: path.join(data, "repos"),
      storage: path.join(data, "storage"),
      auth: path.join(data, "auth.json"),
      database: path.join(data, "bharatcode.db"),
    }),
  ),
)
const generation = await Effect.runPromise(
  Auth.Service.use((auth) =>
    Effect.gen(function* () {
      if (input.action === "create")
        yield* auth.set("bharatcode", {
          type: "oauth",
          access: "synthetic-r1",
          refresh: "synthetic-refresh-r1",
          expires: 1,
        })
      if (input.action === "rotate")
        yield* auth.transaction("bharatcode", (current) => {
          if (current?.type !== "oauth" || current.access !== "synthetic-r1")
            return Effect.die("Unexpected prior synthetic generation")
          return Effect.succeed({
            action: "set" as const,
            info: { type: "oauth" as const, access: "synthetic-r2", refresh: "synthetic-refresh-r2", expires: 2 },
            result: undefined,
          })
        })
      if (input.action === "remove") yield* auth.remove("bharatcode")
      const value = yield* auth.get("bharatcode")
      return value?.type === "oauth" ? value.expires : 0
    }),
  ).pipe(Effect.provide(layer), Effect.scoped),
)
process.stdout.write(JSON.stringify({ generation }))
