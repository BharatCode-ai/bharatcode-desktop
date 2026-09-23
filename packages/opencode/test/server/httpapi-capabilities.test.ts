import { afterEach, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const state = path.join(Global.Path.data, "bharatcode-capabilities.json")
const config = path.join(Global.Path.config, "opencode.jsonc")
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
  await rm(config, { force: true })
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
  expect(body.configuration.scope).toBe("runtime-defaults")
  expect(body.configuration.entries.github).toEqual({ enabled: false, custom: false })
  expect(JSON.stringify(body)).not.toMatch(/clientSecret|environment|command|headers|\/home\//)
})

test("runtime configuration overrides are projected safely, not reported as connection health", async () => {
  await writeFile(
    config,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { github: { type: "remote", url: "https://private.invalid", headers: { Authorization: "private-token" } } },
    }),
  )
  const request = app()
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.state.installed).toEqual({})
  expect(body.configuration).toMatchObject({
    scope: "runtime-defaults",
    entries: { github: { enabled: true, custom: true } },
  })
  expect(JSON.stringify(body)).not.toMatch(/private-token|private.invalid|connected/)
})

test("invalid runtime configuration cannot masquerade as disabled marketplace defaults", async () => {
  await writeFile(config, "{invalid: private-token}")
  const request = app()
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toMatch(/private-token|opencode.jsonc/)
  await writeFile(config, '{"$schema":"https://opencode.ai/config.json"}')
  expect((await request("/capabilities", { headers: auth })).status).toBe(200)
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
  const enabled = (await client.v2.capabilities.get({ throwOnError: true })).data
  expect(enabled.state.installed.github.enabled).toBe(true)
  expect(enabled.configuration?.entries.github).toEqual({ enabled: true, custom: false })
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
