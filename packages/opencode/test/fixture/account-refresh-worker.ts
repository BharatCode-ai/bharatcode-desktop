import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"

type Input = {
  root: string
  gate: string
  marker: string
  ready: string
  output: string
}

const input = JSON.parse(Bun.argv[2] ?? "") as Input
const base = path.join(input.root, "bharatcode-test")
const data = path.join(base, "data")
const cache = path.join(base, "cache")

const { Auth } = await import("../../src/auth")
const { BharatCodeAccount } = await import("../../src/bharatcode/account")
const { Global } = await import("@opencode-ai/core/global")
const { AppFileSystem } = await import("@opencode-ai/core/filesystem")

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
const auth = Auth.layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(global))
const account = BharatCodeAccount.layerWith({
  now: () => 1_000,
  fetch: async (_input, init) => {
    const body = new URLSearchParams(String(init?.body ?? ""))
    const handle = await fs.open(input.marker, "wx", 0o600)
    await handle.writeFile(body.get("refresh_token") ?? "missing")
    await handle.close()
    return new Response(
      JSON.stringify({ access_token: "access-rotated", refresh_token: "refresh-rotated", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  },
}).pipe(Layer.provide(auth))

async function waitForGate() {
  const started = Date.now()
  while (!(await Bun.file(input.gate).exists())) {
    if (Date.now() - started > 15_000) throw new Error("refresh gate timed out")
    await Bun.sleep(10)
  }
}

await fs.writeFile(input.ready, "ready")
await waitForGate()
const token = await Effect.runPromise(BharatCodeAccount.use.accessToken().pipe(Effect.provide(account), Effect.scoped))
await fs.writeFile(input.output, token)
