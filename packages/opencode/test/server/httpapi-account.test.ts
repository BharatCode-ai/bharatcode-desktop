import { beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

import { Global } from "@opencode-ai/core/global"
import { DESKTOP_REDIRECT_URI } from "@/bharatcode/account"
import { AccountPaths } from "@/server/routes/instance/httpapi/groups/account"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_USERNAME: "bharatcode",
            OPENCODE_SERVER_PASSWORD: "secret",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (pathname: string, init?: RequestInit) =>
    handler(new Request(`http://localhost${pathname}`, init), HttpApiApp.context)
}

const authorizedJson = (body: unknown) =>
  ({
    method: "POST",
    headers: {
      authorization: basic("bharatcode", "secret"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }) satisfies RequestInit

describe("Desktop-safe BharatCode account HTTP contract", () => {
  test("shipped v2 catalog fails closed when no account is signed in", async () => {
    // Product policy is memoized for a process. Exercise the shipped graph in a
    // child so generic upstream fixtures cannot inherit that policy afterward.
    if (process.env.BHARATCODE_RUNTIME_HTTP_FIXTURE !== "1") {
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", "shipped v2 catalog"], {
        env: { ...process.env, BHARATCODE_RUNTIME_HTTP_FIXTURE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(out + err)
      expect(code).toBe(0)
      return
    }
    const previous = process.env.BHARATCODE_PRODUCT_POLICY
    process.env.BHARATCODE_PRODUCT_POLICY = "shipped"
    const handler = HttpRouter.toWebHandler(HttpApiApp.createRoutes(), { disableLogger: true })
    try {
      const response = await handler.handler(
        new Request("http://localhost/api/model", {
          headers: { "x-opencode-directory": process.env.OPENCODE_TEST_HOME! },
        }),
        HttpApiApp.context,
      )
      expect(response.status).toBe(500)
      const body = await response.text()
      expect(body).not.toContain("gpt-")
      expect(body).not.toContain("claude-")
      expect(body).not.toContain("apiKey")
    } finally {
      await handler.dispose()
      if (previous === undefined) delete process.env.BHARATCODE_PRODUCT_POLICY
      else process.env.BHARATCODE_PRODUCT_POLICY = previous
    }
  })
  beforeEach(async () => {
    await rm(Global.Path.auth, { force: true })
  })

  test("protects account state and returns no credential fields", async () => {
    const request = app()
    expect((await request(AccountPaths.status)).status).toBe(401)

    const response = await request(AccountPaths.status, {
      headers: { authorization: basic("bharatcode", "secret") },
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ state: "signed-out" })
    expect(JSON.stringify(body)).not.toMatch(/token|credential|path|verifier|authorization.code/i)
  })

  test("starts only the fixed Desktop PKCE flow", async () => {
    const response = await app()(
      AccountPaths.authorize,
      authorizedJson({
        redirectUri: DESKTOP_REDIRECT_URI,
        selectAccount: true,
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { url: string; expiresAt: number }
    const url = new URL(body.url)
    expect(url.origin).toBe("https://evgvlcaxfpwupaiwzqqm.supabase.co")
    expect(url.searchParams.get("redirect_uri")).toBe(DESKTOP_REDIRECT_URI)
    expect(url.searchParams.get("prompt")).toBe("select_account")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(body).not.toHaveProperty("state")
    expect(body).not.toHaveProperty("verifier")
  })

  test("rejects unknown or substituted authorization fields", async () => {
    const request = app()
    expect(
      (await request(AccountPaths.authorize, authorizedJson({ redirectUri: DESKTOP_REDIRECT_URI, extra: true })))
        .status,
    ).toBe(400)
    expect(
      (await request(AccountPaths.authorize, authorizedJson({ redirectUri: "http://127.0.0.1:27182/callback" })))
        .status,
    ).toBe(400)
    expect(
      (
        await request(
          AccountPaths.callback,
          authorizedJson({ callbackUrl: `${DESKTOP_REDIRECT_URI}?code=secret&state=secret`, extra: true }),
        )
      ).status,
    ).toBe(400)
  })

  test("logs out locally behind Basic auth", async () => {
    const request = app()
    expect((await request(AccountPaths.logout, { method: "POST" })).status).toBe(401)
    const response = await request(AccountPaths.logout, authorizedJson({}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})
