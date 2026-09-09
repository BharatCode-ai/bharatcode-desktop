import { describe, expect, test } from "bun:test"
import { accountPrimaryActionLabelKey, accountSignInOptions, accountStatusViewModel } from "./settings-account"
import type { BharatCodeAccountStatus } from "@/context/platform"

const base: BharatCodeAccountStatus = {
  authenticated: true,
  state: "signed_in",
  checkedAt: "2026-07-10T00:00:00.000Z",
}

describe("accountStatusViewModel", () => {
  test("uses calm healthy copy for signed-in accounts", () => {
    const view = accountStatusViewModel({ ...base, email: "user@example.com" })

    expect(view.titleKey).toBe("settings.account.state.signedIn.title")
    expect(view.descriptionKey).toBe("settings.account.state.signedIn.description")
    expect(view.tone).toBe("success")
    expect(view.primaryAction).toBeUndefined()
  })

  test("uses sign-in copy for first-run signed-out state", () => {
    const view = accountStatusViewModel({ ...base, authenticated: false, state: "signed_out" })

    expect(view.titleKey).toBe("settings.account.state.signedOut.title")
    expect(view.descriptionKey).toBe("settings.account.state.signedOut.description")
    expect(view.tone).toBe("muted")
    expect(view.primaryAction).toBe("sign_in")
    expect(accountPrimaryActionLabelKey(view.primaryAction!)).toBe("settings.account.action.signIn")
  })

  test("prompts re-authentication for expired credentials", () => {
    const view = accountStatusViewModel({ ...base, state: "needs_sign_in" })

    expect(view.titleKey).toBe("settings.account.state.needsSignIn.title")
    expect(view.descriptionKey).toBe("settings.account.state.needsSignIn.description")
    expect(view.tone).toBe("warning")
    expect(view.primaryAction).toBe("reconnect")
    expect(accountPrimaryActionLabelKey(view.primaryAction!)).toBe("settings.account.action.reconnect")
  })

  test("classifies connection issues separately from auth issues", () => {
    const view = accountStatusViewModel({
      ...base,
      state: "connection_issue",
    })

    expect(view.titleKey).toBe("settings.account.state.connectionIssue.title")
    expect(view.descriptionKey).toBe("settings.account.state.connectionIssue.description")
    expect(view.tone).toBe("danger")
    expect(view.primaryAction).toBe("refresh")
  })
})

describe("accountSignInOptions", () => {
  test("requests provider account selection only for explicit account switching", () => {
    expect(accountSignInOptions("default")).toEqual({})
    expect(accountSignInOptions("switch_account")).toEqual({ selectAccount: true })
  })
})
