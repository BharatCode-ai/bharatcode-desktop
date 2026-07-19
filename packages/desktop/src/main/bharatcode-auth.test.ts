import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createBharatCodeAccountClient, type BharatCodeSidecarConnection } from "./bharatcode-auth"

const connection: BharatCodeSidecarConnection = {
  url: "http://127.0.0.1:43123",
  username: "bharatcode",
  password: "sidecar-secret",
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("Desktop client of the shared BharatCode account runtime", () => {
  test("projects status without credential or stable-identity fields", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const client = createBharatCodeAccountClient({
      getConnection: async () => connection,
      fetchImpl: async (input, init) => {
        requests.push({ url: input.toString(), authorization: new Headers(init?.headers).get("authorization") })
        return json({
          state: "signed-in",
          accountID: "stable-secret-identity",
          email: "dev@example.com",
          name: "Dev",
          expiresAt: 123_456,
          access_token: "token",
        })
      },
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })

    expect(await client.getAccountStatus()).toEqual({
      state: "signed_in",
      authenticated: true,
      checkedAt: "2026-07-19T00:00:00.000Z",
      email: "dev@example.com",
      name: "Dev",
      expiresAt: 123_456,
    })
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:43123/account/status",
        authorization: `Basic ${Buffer.from("bharatcode:sidecar-secret").toString("base64")}`,
      },
    ])
  })

  test("maps offline, expired, and logged-out runtime states", async () => {
    const responses = [
      { state: "connection-problem", message: "Saved session kept." },
      { state: "sign-in-required", message: "Sign in again." },
      { state: "signed-out" },
    ]
    const client = createBharatCodeAccountClient({
      getConnection: async () => connection,
      fetchImpl: async () => json(responses.shift()),
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })

    expect((await client.getAccountStatus()).state).toBe("connection_issue")
    expect((await client.getAccountStatus()).state).toBe("needs_sign_in")
    expect((await client.getAccountStatus()).state).toBe("signed_out")
  })

  test("uses the closed authorize, callback, refresh-status, and logout contracts", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const client = createBharatCodeAccountClient({
      getConnection: async () => connection,
      fetchImpl: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
        })
        if (input.toString().endsWith("/authorize"))
          return json({
            url: "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1/oauth/authorize?state=state-1",
            expiresAt: 123_456,
          })
        if (input.toString().endsWith("/logout")) return json({ ok: true })
        return json({ state: "signed-in", email: "dev@example.com" })
      },
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })

    expect(await client.beginSignIn({ selectAccount: true })).toEqual({
      url: "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1/oauth/authorize?state=state-1",
      expiresAt: 123_456,
    })
    expect((await client.completeSignIn("bharatcode://auth/callback?code=code&state=state-1")).state).toBe("signed_in")
    expect((await client.refreshAccountStatus()).state).toBe("signed_in")
    expect((await client.logout()).state).toBe("signed_out")
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:43123/account/authorize",
        method: "POST",
        body: JSON.stringify({ redirectUri: "bharatcode://auth/callback", selectAccount: true }),
      },
      {
        url: "http://127.0.0.1:43123/account/callback",
        method: "POST",
        body: JSON.stringify({ callbackUrl: "bharatcode://auth/callback?code=code&state=state-1" }),
      },
      { url: "http://127.0.0.1:43123/account/status", method: "GET", body: undefined },
      { url: "http://127.0.0.1:43123/account/logout", method: "POST", body: "{}" },
    ])
  })

  test("never follows sidecar redirects or authorizes another origin", async () => {
    const client = createBharatCodeAccountClient({
      getConnection: async () => connection,
      fetchImpl: async (_input, init) => {
        expect(init?.redirect).toBe("manual")
        return new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } })
      },
    })
    await expect(client.getAccountStatus()).rejects.toThrow("unsafe redirect")
  })

  test("contains no Desktop credential or provider-config writer", async () => {
    const source = await readFile(join(import.meta.dir, "bharatcode-auth.ts"), "utf8")
    expect(source).not.toMatch(/\.bharatcode|opencode\.jsonc|credentials\.json|writeFile|mkdir|pluginSpec/)
  })
})
