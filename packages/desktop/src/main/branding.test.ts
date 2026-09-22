import { describe, expect, test } from "bun:test"

import { BRANDING, appIdForChannel, productNameForChannel, shouldRegisterProtocol } from "./branding"

describe("BharatCode desktop branding", () => {
  test("only a normal installed release can claim the user's callback", () => {
    for (const channel of ["dev", "beta", "prod"] as const) {
      expect(shouldRegisterProtocol({ packaged: true, channel, diagnostic: true })).toBe(false)
      expect(shouldRegisterProtocol({ packaged: false, channel, diagnostic: false })).toBe(false)
      expect(shouldRegisterProtocol({ packaged: true, channel, diagnostic: false })).toBe(channel !== "dev")
    }
  })
  test("uses BharatCode visible names and protocol", () => {
    expect(BRANDING.appName).toBe("BharatCode")
    expect(BRANDING.protocol).toBe("bharatcode")
    expect(BRANDING.repo.owner).toBe("BharatCode-ai")
    expect(BRANDING.repo.name).toBe("bharatcode-desktop")
  })

  test("builds BharatCode app ids and product names by channel", () => {
    expect(appIdForChannel("dev")).toBe("ai.bharatcode.desktop.dev")
    expect(appIdForChannel("beta")).toBe("ai.bharatcode.desktop.beta")
    expect(appIdForChannel("prod")).toBe("ai.bharatcode.desktop")

    expect(productNameForChannel("dev")).toBe("BharatCode Dev")
    expect(productNameForChannel("beta")).toBe("BharatCode Beta")
    expect(productNameForChannel("prod")).toBe("BharatCode")
  })
})
