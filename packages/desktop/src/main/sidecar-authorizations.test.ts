import { expect, test } from "bun:test"
import { createSidecarAuthorizations } from "./sidecar-authorizations"

const local = { url: "http://127.0.0.1:4101", username: "bharatcode", password: "local-private" }
const wsl = { url: "http://127.0.0.1:4102", username: "bharatcode", password: "wsl-private" }
const request = (id: number, url: string) => ({ id, url, webContentsId: 7, resourceType: "xhr" })

test("native and WSL authorization stay independent and private", () => {
  const auth = createSidecarAuthorizations()
  auth.set("local", local)
  auth.set("wsl:Ubuntu", wsl)
  for (const [id, connection] of [local, wsl].entries()) {
    const input = request(id, `${connection.url}/api/model`)
    expect(auth.beforeRequest(input, 7).cancel).toBe(false)
    expect(auth.beforeSendHeaders({ ...input, requestHeaders: {} }, 7).requestHeaders.Authorization).toBe(
      `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
    )
    auth.complete(id)
  }
  auth.set("wsl:Ubuntu")
  expect(auth.beforeRequest(request(10, wsl.url), 7).cancel).toBe(true)
  expect(auth.beforeRequest(request(11, local.url), 7).cancel).toBe(false)
})

test("stopped and replaced runtimes cannot authorize outstanding requests", () => {
  const auth = createSidecarAuthorizations()
  auth.set("wsl", wsl)
  const input = request(1, wsl.url)
  auth.beforeRequest(input, 7)
  auth.set("wsl", { ...wsl, password: "replacement-private" })
  expect(auth.beforeSendHeaders({ ...input, requestHeaders: {} }, 7).cancel).toBe(true)
  const fresh = request(2, wsl.url)
  expect(auth.beforeRequest(fresh, 7).cancel).toBe(false)
  expect(auth.beforeSendHeaders({ ...fresh, requestHeaders: {} }, 7).cancel).toBe(false)
})

test("cross-runtime, external redirects and unowned windows fail closed", () => {
  const auth = createSidecarAuthorizations()
  auth.set("local", local)
  auth.set("wsl", wsl)
  expect(auth.beforeRequest(request(1, local.url), -1).cancel).toBe(true)
  expect(auth.beforeRequest({ ...request(2, local.url), resourceType: "mainFrame" }, 7).cancel).toBe(true)
  auth.beforeRequest(request(3, local.url), 7)
  auth.beforeRedirect({ id: 3, redirectURL: wsl.url })
  expect(auth.beforeRequest(request(3, wsl.url), 7).cancel).toBe(true)
  auth.beforeRequest(request(4, "https://example.invalid"), 7)
  expect(auth.beforeRequest(request(4, local.url), 7).cancel).toBe(true)
  auth.beforeRequest(request(5, local.url), 7)
  auth.beforeRedirect({ id: 5, redirectURL: "https://example.invalid" })
  expect(auth.beforeRequest(request(5, "https://example.invalid"), 7).cancel).toBe(true)
})

test("unknown header events cannot obtain credentials and ordinary remote auth is preserved", () => {
  const auth = createSidecarAuthorizations()
  auth.set("local", local)
  expect(auth.beforeSendHeaders({ ...request(1, local.url), requestHeaders: {} }, 7).cancel).toBe(true)
  const remote = { ...request(2, "https://example.invalid"), requestHeaders: { Authorization: "user-managed" } }
  expect(auth.beforeRequest(remote, 7).cancel).toBe(false)
  expect(auth.beforeSendHeaders(remote, 7)).toEqual({ cancel: false, requestHeaders: remote.requestHeaders })
  expect(() => auth.set("wsl", local)).toThrow()
})
