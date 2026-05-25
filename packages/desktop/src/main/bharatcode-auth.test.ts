import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BHARATCODE_OAUTH,
  buildBharatCodeSignInUrl,
  handleBharatCodeAuthCallback,
  isBharatCodeAuthCallback,
  signInToBharatCode,
} from "./bharatcode-auth"

describe("BharatCode desktop auth contract", () => {
  test("documents the shared Supabase OAuth backend", () => {
    expect(BHARATCODE_OAUTH.issuer).toBe("https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1")
    expect(BHARATCODE_OAUTH.nativeClientId).toBe("4cad332a-232f-4ef2-9363-12fea4420635")
    expect(BHARATCODE_OAUTH.modelProxy).toBe("https://bharatcode.ai/api/model/v1")
    expect(BHARATCODE_OAUTH.desktopRedirectUri).toBe("bharatcode://auth/callback")
    expect(BHARATCODE_OAUTH.loopbackRedirectUri).toBe("http://127.0.0.1:27182/callback")
  })

  test("builds the browser OAuth URL without requesting provider API keys", () => {
    const url = buildBharatCodeSignInUrl({ state: "state-123", codeChallenge: "challenge-456" })

    expect(url.origin + url.pathname).toBe("https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("4cad332a-232f-4ef2-9363-12fea4420635")
    expect(url.searchParams.get("redirect_uri")).toBe("bharatcode://auth/callback")
    expect(url.searchParams.get("scope")).toBe("openid email profile")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.toString()).not.toContain("api_key")
    expect(url.toString()).not.toContain("offline_access")
  })

  test("recognizes the Desktop deep-link callback", () => {
    expect(isBharatCodeAuthCallback("bharatcode://auth/callback?code=abc&state=xyz")).toBe(true)
    expect(isBharatCodeAuthCallback("opencode://auth/callback?code=abc&state=xyz")).toBe(false)
    expect(isBharatCodeAuthCallback("https://bharatcode.ai/auth/callback")).toBe(false)
  })

  test("completes native desktop OAuth without invoking the CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-desktop-home-"))
    const fetchCalls: Array<{ url: string; body?: string }> = []
    let openedUrl: string | null = null

    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input.toString()
      fetchCalls.push({
        url,
        body: init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
      })

      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            id_token: "id-token",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      if (url.endsWith("/oauth/userinfo")) {
        return new Response(JSON.stringify({ email: "dev@example.com", sub: "user-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      throw new Error(`unexpected fetch: ${url}`)
    }

    try {
      const signIn = signInToBharatCode({
        home,
        fetchImpl,
        openExternal: async (url) => {
          openedUrl = url
        },
        timeoutMs: 500,
      })

      await Promise.resolve()
      expect(openedUrl).toBeTruthy()
      const state = new URL(openedUrl!).searchParams.get("state")
      expect(new URL(openedUrl!).searchParams.get("redirect_uri")).toBe(BHARATCODE_OAUTH.desktopRedirectUri)

      const handled = await handleBharatCodeAuthCallback(
        `bharatcode://auth/callback?code=desktop-code&state=${state}`,
      )
      expect(handled).toBe(true)

      const authState = await signIn
      expect(authState.authenticated).toBe(true)
      expect(authState.configured).toBe(true)

      const credentialsPath = join(home, ".bharatcode", "credentials.json")
      const credentials = JSON.parse(await readFile(credentialsPath, "utf8"))
      expect(credentials.access_token).toBe("access-token")
      expect(credentials.refresh_token).toBe("refresh-token")
      expect(credentials.user.email).toBe("dev@example.com")
      expect((await stat(credentialsPath)).mode & 0o077).toBe(0)

      const config = await readFile(join(home, ".config", "opencode", "opencode.jsonc"), "utf8")
      expect(config).toContain('"bharatcode"')
      expect(fetchCalls[0].body).toContain("grant_type=authorization_code")
      expect(fetchCalls[0].body).toContain("code=desktop-code")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
