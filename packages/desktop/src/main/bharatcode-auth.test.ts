import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  BHARATCODE_OAUTH,
  buildBharatCodeSignInUrl,
  getBharatCodeAccessToken,
  handleBharatCodeAuthCallback,
  ensureBharatCodePlugin,
  isBharatCodeAuthCallback,
  resolveBundledBharatCodePluginPath,
  resolveDesktopResourcesPath,
  signInToBharatCode,
} from "./bharatcode-auth"

const providerModule = () => import("../../resources/provider/bharatcode/index.js")

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
    expect(isBharatCodeAuthCallback("http://127.0.0.1:27182/callback?code=abc&state=xyz")).toBe(true)
    expect(isBharatCodeAuthCallback("http://localhost:27182/callback?code=abc&state=xyz")).toBe(true)
    expect(isBharatCodeAuthCallback("opencode://auth/callback?code=abc&state=xyz")).toBe(false)
    expect(isBharatCodeAuthCallback("http://127.0.0.1:5173/callback?code=abc&state=xyz")).toBe(false)
    expect(isBharatCodeAuthCallback("https://bharatcode.ai/auth/callback")).toBe(false)
  })

  test("completes native desktop OAuth through the loopback callback without invoking the CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-desktop-home-"))
    const fetchCalls: Array<{ url: string; body?: string }> = []
    let openedUrl: string | null = null
    let resolveOpenedUrl!: (url: string) => void
    const openedUrlPromise = new Promise<string>((resolve) => {
      resolveOpenedUrl = resolve
    })

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
          resolveOpenedUrl(url)
        },
        timeoutMs: 500,
      })

      openedUrl = await openedUrlPromise
      const state = new URL(openedUrl).searchParams.get("state")
      expect(new URL(openedUrl).searchParams.get("redirect_uri")).toBe(BHARATCODE_OAUTH.loopbackRedirectUri)

      const callback = await fetch(`http://127.0.0.1:27182/callback?code=desktop-code&state=${state}`)
      expect(callback.ok).toBe(true)

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

  test("refreshes and persists expired credentials before returning an access token", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-desktop-token-"))
    const credentialsPath = join(home, ".bharatcode", "credentials.json")
    const fetchCalls: Array<{ url: string; body?: string }> = []

    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input.toString()
      fetchCalls.push({
        url,
        body: init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
      })

      return new Response(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "new-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    try {
      await mkdir(dirname(credentialsPath), { recursive: true })
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "expired-token",
          refresh_token: "refresh-token",
          expires_at: Math.floor(Date.now() / 1000) - 60,
        }),
      )

      const token = await getBharatCodeAccessToken({ home, fetchImpl })

      expect(token).toBe("fresh-token")
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0].url).toBe(`${BHARATCODE_OAUTH.issuer}/oauth/token`)
      expect(fetchCalls[0].body).toContain("grant_type=refresh_token")
      expect(fetchCalls[0].body).toContain("refresh_token=refresh-token")

      const saved = JSON.parse(await readFile(credentialsPath, "utf8"))
      expect(saved.access_token).toBe("fresh-token")
      expect(saved.refresh_token).toBe("new-refresh-token")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("falls back to app-driven reauth when the stored refresh token is rejected", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-desktop-reauth-"))
    const credentialsPath = join(home, ".bharatcode", "credentials.json")
    const fetchCalls: Array<{ url: string; body?: string }> = []
    let reauthCount = 0

    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input.toString()
      fetchCalls.push({
        url,
        body: init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
      })

      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }

    try {
      await mkdir(dirname(credentialsPath), { recursive: true })
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "expired-token",
          refresh_token: "rejected-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) - 60,
        }),
      )

      const token = await getBharatCodeAccessToken({
        home,
        fetchImpl,
        reauthorize: async () => {
          reauthCount += 1
          return {
            access_token: "reauth-token",
            refresh_token: "reauth-refresh-token",
            token_type: "bearer",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }
        },
      } as any)

      expect(token).toBe("reauth-token")
      expect(reauthCount).toBe(1)
      expect(fetchCalls[0].body).toContain("grant_type=refresh_token")

      const saved = JSON.parse(await readFile(credentialsPath, "utf8"))
      expect(saved.access_token).toBe("reauth-token")
      expect(saved.refresh_token).toBe("reauth-refresh-token")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("replaces the cached npm BharatCode plugin with the managed desktop plugin path", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-desktop-config-"))
    const configPath = join(home, ".config", "opencode", "opencode.jsonc")
    const managedPlugin = "/tmp/bharatcode-desktop/resources/provider/bharatcode/index.js"

    try {
      await mkdir(dirname(configPath), { recursive: true })
      await Bun.write(
        configPath,
        JSON.stringify(
          {
            plugin: ["other-plugin", ["bharatcode", { model: "bharatcode/custom-model" }]],
          },
          null,
          2,
        ),
      )

      await ensureBharatCodePlugin({ configPath, pluginSpec: managedPlugin })

      const config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.plugin).toEqual(["other-plugin", [managedPlugin, { model: "bharatcode/custom-model" }]])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("resolves packaged desktop resources outside app.asar for the OpenCode sidecar", () => {
    const packagedResources = "/opt/BharatCode/resources"
    const appAsarMainBundle = "/opt/BharatCode/resources/app.asar/out/main"

    const resourcesPath = resolveDesktopResourcesPath({
      packaged: true,
      processResourcesPath: packagedResources,
      mainBundleDir: appAsarMainBundle,
    })

    expect(resourcesPath).toBe(packagedResources)
    expect(resourcesPath).not.toContain("app.asar")
    expect(resolveBundledBharatCodePluginPath(resourcesPath)).toBe(
      join(packagedResources, "provider", "bharatcode", "index.js"),
    )
  })

  test("packages managed provider resources as real files outside app.asar", async () => {
    const builderConfig = await readFile(join(import.meta.dir, "..", "..", "electron-builder.config.ts"), "utf8")

    expect(builderConfig).toContain('from: "resources/provider"')
    expect(builderConfig).toContain('to: "provider"')
    expect(builderConfig).toContain('from: "resources/capabilities"')
    expect(builderConfig).toContain('to: "capabilities"')
  })

  test("allows unsigned macOS beta packaging without Apple credentials", async () => {
    const builderConfig = await readFile(join(import.meta.dir, "..", "..", "electron-builder.config.ts"), "utf8")

    expect(builderConfig).toContain("BHARATCODE_ALLOW_UNSIGNED_MAC")
    expect(builderConfig).toContain("identity: allowUnsignedMac ? null : undefined")
    expect(builderConfig).toContain("notarize: !allowUnsignedMac")
    expect(builderConfig).toContain("sign: !allowUnsignedMac")
  })

  test("the bundled provider retries a 401 with a refreshed bearer token", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-desktop-provider-"))
    const credentialsPath = join(home, ".bharatcode", "credentials.json")
    const modelAuthorizationHeaders: string[] = []
    let refreshCount = 0

    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith("/auth/v1/oauth/token")) {
        refreshCount += 1
        return new Response(
          JSON.stringify({
            access_token: "fresh-provider-token",
            refresh_token: "fresh-provider-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      modelAuthorizationHeaders.push(new Headers(init?.headers).get("authorization") || "")
      return new Response(modelAuthorizationHeaders.length === 1 ? "expired" : "ok", {
        status: modelAuthorizationHeaders.length === 1 ? 401 : 200,
      })
    }

    try {
      await mkdir(dirname(credentialsPath), { recursive: true })
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "stale-provider-token",
          refresh_token: "provider-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      )

      const { BharatCodePlugin } = await providerModule()
      const plugin = await BharatCodePlugin({}, { credentialsHome: home, fetchImpl })
      const config: any = {}
      await plugin.config(config)
      const response = await config.provider.bharatcode.options.fetch("https://bharatcode.ai/api/model/v1/chat", {})

      expect(response.status).toBe(200)
      expect(refreshCount).toBe(1)
      expect(modelAuthorizationHeaders).toEqual(["Bearer stale-provider-token", "Bearer fresh-provider-token"])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
