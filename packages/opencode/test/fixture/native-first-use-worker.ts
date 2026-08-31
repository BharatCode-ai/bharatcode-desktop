import path from "node:path"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { withMigrationMaintenanceLock } from "../../src/storage/migration-maintenance-lock"

const input = JSON.parse(await Bun.stdin.text()) as { root: string; action: string }
if (!path.isAbsolute(input.root) || !path.basename(input.root).startsWith("bc-first-use-"))
  throw new Error("Synthetic root required")
for (const target of [Global.Path.auth, Global.Path.data, Global.Path.state, Global.Path.config]) {
  if (!target.startsWith(input.root + path.sep)) throw new Error("Isolated production paths required")
}
if (input.action === "global") await Global.ensure()
if (input.action === "migration") {
  await withMigrationMaintenanceLock(path.dirname(Global.Path.auth), async () => {})
  await Global.ensure()
}
const generation = await Effect.runPromise(
  Auth.Service.use((auth) =>
    Effect.gen(function* () {
      if (input.action === "global" || input.action === "migration")
        yield* auth.set("bharatcode", {
          type: "oauth",
          access: "synthetic-first",
          refresh: "synthetic-first-refresh",
          expires: 1,
        })
      if (input.action === "rotate")
        yield* auth.transaction("bharatcode", (current) => {
          if (current?.type !== "oauth" || current.expires !== 1) return Effect.die("Unexpected synthetic generation")
          return Effect.succeed({
            action: "set" as const,
            info: { type: "oauth" as const, access: "synthetic-next", refresh: "synthetic-next-refresh", expires: 2 },
            result: undefined,
          })
        })
      if (input.action === "logout") yield* auth.remove("bharatcode")
      const value = yield* auth.get("bharatcode")
      return value?.type === "oauth" ? value.expires : 0
    }),
  ).pipe(
    Effect.provide(Auth.layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Global.defaultLayer))),
    Effect.scoped,
  ),
)
process.stdout.write(JSON.stringify({ generation }))
