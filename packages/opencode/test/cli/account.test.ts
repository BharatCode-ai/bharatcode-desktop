import { describe, expect, test } from "bun:test"

import {
  AccountCommand,
  LoginCommand,
  LogoutCommand,
  ReconnectCommand,
  StatusCommand,
  formatAccountStatus,
  localLogoutMessage,
} from "../../src/cli/cmd/account"

describe("BharatCode account CLI", () => {
  test("publishes one branded account command tree", () => {
    expect(AccountCommand.command).toBe("auth")
    expect(AccountCommand.aliases).toEqual(["account"])
    expect(LoginCommand.command).toBe("login")
    expect(StatusCommand.command).toBe("status")
    expect(LogoutCommand.command).toBe("logout")
    expect(ReconnectCommand.command).toBe("reconnect")
  })

  test("formats signed-out and reauthorization states with an action", () => {
    expect(formatAccountStatus({ state: "signed-out" })).toEqual([
      "Signed out of BharatCode.",
      "Run `bharatcode auth login` to sign in.",
    ])
    expect(
      formatAccountStatus({
        state: "sign-in-required",
        accountID: "stable-user-id",
        errorCode: "refresh_token_not_found",
        message: "upstream detail must not be echoed",
      }),
    ).toEqual(["Your BharatCode session needs attention.", "Run `bharatcode auth login` to sign in again."])
  })

  test("formats safe signed-in identity without exposing stable IDs or credentials", () => {
    const lines = formatAccountStatus({
      state: "signed-in",
      accountID: "stable-user-id",
      email: "shrey@example.com",
      name: "Shrey",
      picture: "https://example.invalid/avatar.png",
      expiresAt: 1_800_000_000_000,
    })
    expect(lines).toEqual(["Signed in to BharatCode.", "Shrey", "shrey@example.com"])
    expect(lines.join(" ")).not.toContain("stable-user-id")
    expect(lines.join(" ")).not.toContain("avatar")
    expect(lines.join(" ")).not.toContain("1_800")
  })

  test("keeps temporary service failures distinct from sign-in failures", () => {
    expect(
      formatAccountStatus({
        state: "connection-problem",
        accountID: "stable-user-id",
        message: "socket detail must not be echoed",
      }),
    ).toEqual([
      "BharatCode could not verify your account right now.",
      "Your saved session was kept. Run `bharatcode auth reconnect` to try again.",
    ])
  })

  test("describes logout as local-only", () => {
    expect(localLogoutMessage).toBe("Signed out locally. Existing access tokens may remain valid until they expire.")
  })
})
