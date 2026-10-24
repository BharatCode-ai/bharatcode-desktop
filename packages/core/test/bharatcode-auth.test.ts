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
