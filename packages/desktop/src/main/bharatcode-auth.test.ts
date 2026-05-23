import { describe, expect, test } from "bun:test"

import {
  BHARATCODE_OAUTH,
  buildBharatCodeCliCommands,
  buildBharatCodeSignInUrl,
  isBharatCodeAuthCallback,
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

  test("uses the BharatCode CLI login and config commands for MVP auth", () => {
    expect(buildBharatCodeCliCommands()).toEqual([
      { command: "bharatcode", args: ["auth", "login"] },
      { command: "bharatcode", args: ["opencode", "configure"] },
    ])
  })
})
