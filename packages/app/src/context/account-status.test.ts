import { expect, test } from "bun:test"
import { createAccountStatusTracker } from "./account-status-tracker"

const state = (revision: number, authenticated: boolean) => ({
  revision,
  authenticated,
  state: authenticated ? ("signed_in" as const) : ("signed_out" as const),
  checkedAt: "now",
})

test("both account views reject a late initial status response after a callback event", () => {
  const views = [createAccountStatusTracker(), createAccountStatusTracker()]
  for (const view of views) {
    expect(view.accept(state(4, true))).toEqual(state(4, true))
    expect(view.accept(state(2, false))).toEqual(state(4, true))
  }
})

test("late sign-in response cannot restore a signed-in display after logout", () => {
  const view = createAccountStatusTracker()
  view.accept(state(7, false))
  expect(view.accept(state(6, true))).toEqual(state(7, false))
})

test("unversioned older transport cannot overwrite an observed revision", () => {
  const view = createAccountStatusTracker()
  view.accept(state(4, true))
  expect(view.accept({ state: "signed_out", authenticated: false, checkedAt: "before" })).toEqual(state(4, true))
})

test("transport failure stays retryable without fabricating logout or overwriting a newer callback", () => {
  const tracker = createAccountStatusTracker()
  expect(tracker.failed(undefined)).toMatchObject({ state: "connection_issue", authenticated: false })
  tracker.accept(state(3, true))
  const before = tracker.snapshot()
  expect(tracker.failed(before)).toMatchObject({ revision: 3, state: "connection_issue", authenticated: true })
  const old = tracker.snapshot()
  tracker.accept(state(4, false))
  expect(tracker.failed(old)).toEqual(state(4, false))
})
