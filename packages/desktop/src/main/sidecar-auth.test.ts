import { describe, expect, test } from "bun:test"

import { createSidecarAuthorizationPolicy } from "./sidecar-auth"

const secret = "sidecar-secret"

describe("Electron main sidecar authorization policy", () => {
  const create = () =>
    createSidecarAuthorizationPolicy({
      origin: "http://127.0.0.1:43123",
      username: "bharatcode",
      password: secret,
    })

  test("injects Basic only for the exact active loopback origin", () => {
    const policy = create()
    const exact = policy.authorize("http://127.0.0.1:43123/account/status", new Headers({ authorization: "fake" }))

    expect(exact.get("authorization")).toBe(`Basic ${Buffer.from(`bharatcode:${secret}`).toString("base64")}`)
    expect(policy.authorize("http://127.0.0.1:43124/account/status", new Headers()).get("authorization")).toBeNull()
    expect(policy.authorize("http://localhost:43123/account/status", new Headers()).get("authorization")).toBeNull()
    expect(policy.authorize("https://127.0.0.1:43123/account/status", new Headers()).get("authorization")).toBeNull()
    expect(policy.authorize("https://bharatcode.ai/account", new Headers()).get("authorization")).toBeNull()
  })

  test("strips credentials after redirect or lifecycle rotation", () => {
    const first = create()
    const redirected = first.authorizeRedirect(
      "http://127.0.0.1:43123/account/status",
      "https://attacker.invalid/collect",
      first.authorize("http://127.0.0.1:43123/account/status", new Headers()),
    )
    expect(redirected.get("authorization")).toBeNull()
    expect(
      first
        .authorizeRedirect(
          "http://127.0.0.1:43123/account/status",
          "http://127.0.0.1:43123/account/next",
          first.authorize("http://127.0.0.1:43123/account/status", new Headers()),
        )
        .get("authorization"),
    ).toBeNull()

    first.invalidate()
    expect(first.authorize("http://127.0.0.1:43123/account/status", new Headers()).get("authorization")).toBeNull()
    const second = createSidecarAuthorizationPolicy({
      origin: "http://127.0.0.1:43123",
      username: "bharatcode",
      password: "rotated-secret",
    })
    expect(second.authorize("http://127.0.0.1:43123/account/status", new Headers()).get("authorization")).toBe(
      `Basic ${Buffer.from("bharatcode:rotated-secret").toString("base64")}`,
    )
  })

  test("dispatches only owned exact-origin XHR or websocket requests and blocks every redirect", () => {
    const policy = create()
    const exact = {
      id: 7,
      url: "http://127.0.0.1:43123/account/status",
      resourceType: "xhr",
      webContentsId: 17,
    }
    expect(policy.beforeRequest(exact, 17)).toEqual({ cancel: false })
    expect(
      policy.beforeSendHeaders({ ...exact, requestHeaders: { Authorization: "renderer-controlled" } }, 17),
    ).toEqual({
      cancel: false,
      requestHeaders: { Authorization: `Basic ${Buffer.from(`bharatcode:${secret}`).toString("base64")}` },
    })

    expect(policy.beforeRequest({ ...exact, id: 8, webContentsId: 18 }, 17)).toEqual({ cancel: true })
    expect(policy.beforeRequest({ ...exact, id: 9, resourceType: "mainFrame" }, 17)).toEqual({ cancel: true })
    expect(policy.beforeRequest({ ...exact, id: 10, url: "http://user@127.0.0.1:43123/account/status" }, 17)).toEqual({
      cancel: true,
    })

    const remote = {
      ...exact,
      id: 11,
      url: "https://bharatcode.ai/account",
      requestHeaders: { Authorization: "Bearer remote-token" },
    }
    expect(policy.beforeRequest(remote, 17)).toEqual({ cancel: false })
    expect(policy.beforeSendHeaders(remote, 17)).toEqual({
      cancel: false,
      requestHeaders: { Authorization: "Bearer remote-token" },
    })

    policy.beforeRedirect({ id: 7, redirectURL: "http://127.0.0.1:43123/account/next" })
    expect(policy.beforeRequest({ ...exact, url: "http://127.0.0.1:43123/account/next" }, 17)).toEqual({ cancel: true })
  })

  test("requires a literal loopback origin with a port", () => {
    for (const origin of [
      "http://localhost:43123",
      "https://127.0.0.1:43123",
      "http://127.0.0.1",
      "http://user@127.0.0.1:43123",
      "http://127.0.0.1:43123/path",
    ]) {
      expect(() => createSidecarAuthorizationPolicy({ origin, username: "bharatcode", password: secret })).toThrow(
        "exact loopback origin",
      )
    }
  })
})
