import { expect, test } from "bun:test"
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2/client"
import { registerBrowseMcp } from "./settings-browse"
import { BHARATCODE_ENGLISH } from "@/i18n/bharatcode"

test("pairing instructions cover installed, store and review-pending unpacked paths", () => {
  const copy = BHARATCODE_ENGLISH["settings.browse.instructions"]
  expect(copy).toContain("already installed")
  expect(copy).toContain("Chrome Web Store when available")
  expect(copy).toContain("While store review is pending")
  expect(copy).toContain("Load unpacked")
  expect(copy).toContain("enter the pairing code")
  expect(copy).toContain(BHARATCODE_ENGLISH["settings.browse.check"])
  expect(copy).toContain("10 minutes")
  expect(copy).not.toContain("1.15.48")
})

test("explicit Browse setup/check never PATCHes matching configuration", async () => {
  for (const root of ["/home/fixture/browse", "C:\\Users\\fixture\\browse"]) {
    const slash = root.startsWith("C:") ? "\\" : "/"
    const result = {
      command: [root + slash + "a".repeat(64) + slash + (slash === "\\" ? "browse.exe" : "browse"), "mcp"],
      environment: { OPENCODE_BROWSER_HOME: root + slash + "relay", OPENCODE_BROWSER_PORT: "19989" },
    }
    const fixture = configFixture({
      mcp: { "bharatcode-browse": { type: "local", ...result, enabled: true, timeout: 42_000 } },
    })
    expect(await registerBrowseMcp(fixture.config, result)).toBe("connected")
    expect(await registerBrowseMcp(fixture.config, result)).toBe("connected")
    expect(fixture.requests).toEqual(["GET /global/config", "GET /global/config"])
  }
})

test("explicit Browse setup registers once, then check is read-only", async () => {
  const result = {
    command: ["/fixture/browse/" + "a".repeat(64) + "/browse", "mcp"],
    environment: { OPENCODE_BROWSER_HOME: "/fixture/browse/relay", OPENCODE_BROWSER_PORT: "19989" },
  }
  const fixture = configFixture({})
  expect(await registerBrowseMcp(fixture.config, result)).toBe("connected")
  expect(await registerBrowseMcp(fixture.config, result)).toBe("connected")
  expect(fixture.requests).toEqual(["GET /global/config", "PATCH /global/config", "GET /global/config"])
})

test("explicit Browse setup leaves a foreign MCP entry untouched", async () => {
  const fixture = configFixture({ mcp: { "bharatcode-browse": { type: "remote", url: "https://fixture.invalid" } } })
  expect(
    await registerBrowseMcp(fixture.config, {
      command: ["/fixture/browse/" + "a".repeat(64) + "/browse", "mcp"],
      environment: { OPENCODE_BROWSER_HOME: "/fixture/browse/relay" },
    }),
  ).toBe("conflict")
  expect(fixture.requests).toEqual(["GET /global/config"])
})

function configFixture(initial: Config) {
  const requests: string[] = []
  const current = structuredClone(initial)
  const client = createOpencodeClient({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const request = new Request(input)
        requests.push(`${request.method} ${new URL(request.url).pathname}`)
        if (request.method === "PATCH") Object.assign(current, await request.json())
        return Response.json(current)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  return { config: client.global.config, requests }
}
