import { describe, expect, test } from "bun:test"
import { bharatCodeProviderConnectMode } from "./dialog-connect-provider-mode"

describe("bharatCodeProviderConnectMode", () => {
  test("uses Desktop OAuth for BharatCode when the platform bridge is available", () => {
    expect(bharatCodeProviderConnectMode("bharatcode", { signInToBharatCode: async () => undefined })).toBe(
      "desktop_oauth",
    )
  })

  test("keeps non-BharatCode providers on the existing provider auth flow", () => {
    expect(bharatCodeProviderConnectMode("anthropic", { signInToBharatCode: async () => undefined })).toBe(
      "provider_auth",
    )
  })

  test("falls back to guidance instead of asking for raw BharatCode provider internals", () => {
    expect(bharatCodeProviderConnectMode("bharatcode", {})).toBe("legacy_guidance")
  })
})
