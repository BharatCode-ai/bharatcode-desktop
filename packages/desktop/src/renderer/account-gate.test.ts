import { describe, expect, test } from "bun:test"
import { BHARATCODE_ENGLISH } from "../../../app/src/i18n/bharatcode"

describe("desktop first-run auth gate copy", () => {
  test("defines all required first-run onboarding keys", () => {
    expect(BHARATCODE_ENGLISH["account.gate.title"]).toBe("Welcome to BharatCode")
    expect(BHARATCODE_ENGLISH["account.gate.description"]).toContain("BharatCode account")
    expect(BHARATCODE_ENGLISH["account.gate.feature.account"]).toBe("Single sign-in with your BharatCode account")
    expect(BHARATCODE_ENGLISH["account.gate.feature.models"]).toBe("Built-in access to optimized BharatCode models")
    expect(BHARATCODE_ENGLISH["account.gate.feature.noKeys"]).toBe("No manual API keys or provider setup required")
    expect(BHARATCODE_ENGLISH["account.gate.continue"]).toBe("Sign in to BharatCode")
    expect(BHARATCODE_ENGLISH["account.gate.browser"]).toContain("browser")
    expect(BHARATCODE_ENGLISH["account.gate.unavailable"]).toContain("BharatCode account")
  })

  test("does not expose provider configuration or api key entry prompts in first-run copy", () => {
    const gateStrings = [
      BHARATCODE_ENGLISH["account.gate.title"],
      BHARATCODE_ENGLISH["account.gate.description"],
      BHARATCODE_ENGLISH["account.gate.feature.account"],
      BHARATCODE_ENGLISH["account.gate.feature.models"],
      BHARATCODE_ENGLISH["account.gate.feature.noKeys"],
      BHARATCODE_ENGLISH["account.gate.continue"],
      BHARATCODE_ENGLISH["account.gate.browser"],
      BHARATCODE_ENGLISH["account.gate.unavailable"],
    ]

    for (const text of gateStrings) {
      expect(text).not.toMatch(/enter.*api\s*key/i)
      expect(text).not.toMatch(/select.*provider/i)
      expect(text).not.toMatch(/opencode/i)
    }
  })
})
