import { describe, expect, test } from "bun:test"
import { BharatCodeAuth } from "../src/bharatcode-auth"

describe("native BharatCode auth endpoint", () => {
  test("defaults to the first-party issuer", () => {
    expect(BharatCodeAuth.issuer({})).toBe("https://auth.bharatcode.ai/auth/v1")
  })

  test.each([
    ["https://auth.bharatcode.ai", "https://auth.bharatcode.ai/auth/v1"],
    ["https://auth.bharatcode.ai/", "https://auth.bharatcode.ai/auth/v1"],
    ["https://auth.bharatcode.ai/auth/v1/", "https://auth.bharatcode.ai/auth/v1"],
    ["https://legacy.supabase.co/auth/v1", "https://legacy.supabase.co/auth/v1"],
    ["http://127.0.0.1:54321", "http://127.0.0.1:54321/auth/v1"],
    ["http://localhost:54321/auth/v1", "http://localhost:54321/auth/v1"],
    ["http://[::1]:54321/", "http://[::1]:54321/auth/v1"],
  ])("normalizes explicit endpoint %s for either env prefix", (input, expected) => {
    expect(BharatCodeAuth.issuer({ BHARATCODE_AUTH_URL: input })).toBe(expected)
    expect(BharatCodeAuth.issuer({ OPENCODE_AUTH_URL: input })).toBe(expected)
  })

  test("branded override wins over the legacy prefix", () => {
    expect(BharatCodeAuth.issuer({ BHARATCODE_AUTH_URL: "http://localhost:54321", OPENCODE_AUTH_URL: "invalid" })).toBe(
      "http://localhost:54321/auth/v1",
    )
  })

  test.each([
    "",
    " auth.bharatcode.ai ",
    "https://auth.bharatcode.ai\n",
    "https://",
    "//auth.bharatcode.ai",
    "ftp://auth.bharatcode.ai",
    "http://auth.bharatcode.ai",
    "http://localhost.attacker.invalid",
    "http://0.0.0.0:54321",
    "http://192.168.1.1:54321",
    "http://127.0.0.1:99999",
    "https://user:secret@auth.bharatcode.ai",
    "https://auth.bharatcode.ai?token=secret",
    "https://auth.bharatcode.ai#fragment",
    "https://auth.bharatcode.ai/auth/v1/oauth/authorize",
    "https://auth.bharatcode.ai/wrong/../auth/v1",
    "https://auth.bharatcode.ai\\auth\\v1",
  ])("fails closed for malformed or unsafe override %j", (input) => {
    expect(() => BharatCodeAuth.issuer({ BHARATCODE_AUTH_URL: input })).toThrow(BharatCodeAuth.configurationMessage)
    expect(() => BharatCodeAuth.issuer({ OPENCODE_AUTH_URL: input })).toThrow(BharatCodeAuth.configurationMessage)
    expect(() =>
      BharatCodeAuth.issuer({ BHARATCODE_AUTH_URL: input, OPENCODE_AUTH_URL: "https://auth.bharatcode.ai" }),
    ).toThrow(BharatCodeAuth.configurationMessage)
  })
})

describe("native BharatCode API authority", () => {
  test("defaults remain separate, operator-selected authorities", () => {
    expect(BharatCodeAuth.apiOrigin({})).toBe("https://bharatcode.ai")
    expect(BharatCodeAuth.issuer({ BHARATCODE_API_BASE_URL: "https://api.example.test" })).toBe(
      BharatCodeAuth.DEFAULT_ISSUER,
    )
  })

  test.each([
    "https://api.example.test",
    "https://api.example.test:8443",
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://[::1]:54321",
  ])("accepts explicit canonical origin %s", (input) => {
    expect(BharatCodeAuth.apiOrigin({ BHARATCODE_API_BASE_URL: input })).toBe(input)
  })

  test.each([
    "",
    " https://api.example.test",
    "https://api.example.test\n",
    "https://",
    "//api.example.test",
    "ftp://api.example.test",
    "http://api.example.test",
    "http://localhost.attacker.invalid",
    "http://0.0.0.0:54321",
    "http://192.168.1.1:54321",
    "http://127.0.0.1:99999",
    "https://user:secret@api.example.test",
    "https://@api.example.test",
    "https://api.example.test/",
    "https://api.example.test/api/model/v1",
    "https://api.example.test?token=secret",
    "https://api.example.test#",
    "https://api.example.test/wrong/..",
    "https://api.example.test\\path",
    "https://api.example.test:443",
    "https://API.example.test",
    "https://%61pi.example.test",
    "http://127.1",
    "http://2130706433",
    "http://0177.0.0.1",
    "https://api.example.test:",
    "https:////api.example.test",
  ])("rejects invalid origins and parser repairs without reflecting input: %j", (input) => {
    expect(() => BharatCodeAuth.apiOrigin({ BHARATCODE_API_BASE_URL: input })).toThrow(
      BharatCodeAuth.apiConfigurationMessage,
    )
  })

  test("WSL forwards only the selected Auth and API origins, never unrelated environment values", () => {
    expect(
      BharatCodeAuth.sidecarEnvironment({
        BHARATCODE_AUTH_URL: "https://auth.example.test/auth/v1",
        OPENCODE_AUTH_URL: "https://ignored.example.test",
        BHARATCODE_API_BASE_URL: "https://api.example.test",
        OPENAI_API_KEY: "synthetic-secret",
        ADMIN_KEY: "synthetic-secret",
      }),
    ).toEqual({
      BHARATCODE_AUTH_URL: "https://auth.example.test/auth/v1",
      BHARATCODE_API_BASE_URL: "https://api.example.test",
    })
    expect(() => BharatCodeAuth.sidecarEnvironment({ BHARATCODE_API_BASE_URL: "" })).toThrow()
    expect(() => BharatCodeAuth.sidecarEnvironment({ BHARATCODE_AUTH_URL: "" })).toThrow()
  })
})
