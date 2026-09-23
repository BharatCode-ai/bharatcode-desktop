// Run in its own process: environment.ts must isolate storage before runtime imports.
import { exerciseDatabasePath } from "./environment"
import { Effect, Layer } from "effect"
import { runtime } from "./runtime"
import { runScenario } from "./runner"
import { parseOptions } from "./routing"
import { http } from "./dsl"
import { TestLLMServer } from "../../lib/llm-server"

const modules = await runtime()
const observations: boolean[] = []
modules.AppLayer = Layer.mergeAll(
  modules.AppLayer,
  Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.promise(async () => {
        observations.push(await Bun.file(exerciseDatabasePath).exists())
      }),
    ),
  ),
)

for (const mode of ["success", "assertion-failure", "seed-failure"]) {
  const scenario = http.protected
    .get("/global/health", `lifecycle.${mode}`)
    .global()
    .seeded(() => (mode === "seed-failure" ? Effect.die("seed failure") : Effect.void))
    .json(200, () => {
      if (mode === "assertion-failure") throw new Error("assertion failure")
    })
  const result = await Effect.runPromise(
    runScenario(parseOptions([]))(scenario).pipe(Effect.provide(TestLLMServer.layer)),
  )
  if (result.status !== (mode === "success" ? "pass" : "fail")) {
    throw new Error(`unexpected scenario outcome: ${JSON.stringify(result)}`)
  }
  if (observations.length === 0 || !observations.every(Boolean)) {
    throw new Error("database removed before the scenario application scope closed")
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    if (await Bun.file(exerciseDatabasePath + suffix).exists()) throw new Error("database reset incomplete")
  }
}
if (observations.length !== 3) throw new Error("scenario application scope was retained")
console.log("scenario lifecycle passed")
process.exit(0)
