import { afterEach, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const state = path.join(Global.Path.data, "bharatcode-capabilities.json")
const auth = { authorization: `Basic ${Buffer.from("bharatcode:secret").toString("base64")}` }
const handlers: Array<{ dispose: () => Promise<void> }> = []
function app() {
  const server = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ OPENCODE_SERVER_USERNAME: "bharatcode", OPENCODE_SERVER_PASSWORD: "secret" }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  handlers.push(server)
  return (route: string, init?: RequestInit) =>
    server.handler(new Request(`http://localhost${route}`, init), HttpApiApp.context)
}
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.dispose()))
  await rm(state, { force: true })
})
const action = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify(body),
})

test("marketplace read and writes require sidecar authorization", async () => {
  const request = app()
  expect((await request("/capabilities")).status).toBe(401)
  expect((await request("/capabilities/github", { method: "POST" })).status).toBe(401)
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.catalog).toHaveLength(9)
  expect(body.state).toEqual({ version: 1, installed: {} })
  expect(JSON.stringify(body)).not.toMatch(/clientSecret|environment|command|headers|\/home\//)
})

test("install stays disabled, uninstall persists, and reload is explicit", async () => {
  const request = app()
  const installed = await request("/capabilities/github", action({ action: "install" }))
  expect(installed.status).toBe(200)
  expect(await installed.json()).toMatchObject({
    state: { installed: { github: { enabled: false } } },
    reloadRequired: true,
  })
  const reread = await request("/capabilities", { headers: auth })
  expect(await reread.json()).toMatchObject({ state: { installed: { github: { enabled: false } } } })
  const removed = await request("/capabilities/github", action({ action: "uninstall" }))
  expect(removed.status).toBe(200)
  expect((await removed.json()).state.installed).toEqual({})
})

test("generated SDK reads and changes marketplace state through the protected handler", async () => {
  const request = app()
  const client = createOpencodeClient({
    baseUrl: "http://localhost",
    headers: auth,
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const source = input instanceof Request ? input : new Request(input)
        return request(new URL(source.url).pathname, {
          method: source.method,
          headers: source.headers,
          body: source.method === "GET" ? undefined : await source.text(),
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  expect((await client.v2.capabilities.get({ throwOnError: true })).data.state.installed).toEqual({})
  const result = await client.v2.capabilities.change(
    { id: "github", bharatCodeCapabilityChange: { action: "enable" } },
    { throwOnError: true },
  )
  expect(result.data).toEqual({ state: { version: 1, installed: { github: { enabled: true } } }, reloadRequired: true })
  expect((await client.v2.capabilities.get({ throwOnError: true })).data.state.installed.github.enabled).toBe(true)
})

test("invalid actions and unknown IDs are rejected; storage errors expose no payload", async () => {
  const request = app()
  expect(
    (await request("/capabilities/github", action({ action: "enable", url: "https://secret.invalid" }))).status,
  ).toBe(400)
  expect((await request("/capabilities/github", action({ action: "run" }))).status).toBe(400)
  expect((await request("/capabilities/not-known", action({ action: "enable" }))).status).toBe(400)
  await writeFile(state, "private-token=/private/source", { mode: 0o600 })
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(503)
  const body = await response.text()
  expect(body).toContain("Capability state is unavailable")
  expect(body).not.toMatch(/private-token|\/private\/source|\/home\//)
})
