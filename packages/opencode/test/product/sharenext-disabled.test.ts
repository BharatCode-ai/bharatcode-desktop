import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { SHARE_NEXT_ENABLED } from "@/product/feature-gates"
import { ShareNext } from "@/share/share-next"
import { SessionID } from "@/session/schema"

const originalFetch = globalThis.fetch
const originalShareBaseUrl = process.env.BHARATCODE_SHARE_BASE_URL
const originalShareToken = process.env.BHARATCODE_SHARE_ACCESS_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalShareBaseUrl === undefined) delete process.env.BHARATCODE_SHARE_BASE_URL
  else process.env.BHARATCODE_SHARE_BASE_URL = originalShareBaseUrl
  if (originalShareToken === undefined) delete process.env.BHARATCODE_SHARE_ACCESS_TOKEN
  else process.env.BHARATCODE_SHARE_ACCESS_TOKEN = originalShareToken
})

async function expectUnavailable(effect: Effect.Effect<unknown, unknown, ShareNext.Service>) {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(ShareNext.defaultLayer)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  expect(Cause.squash(exit.cause)).toMatchObject({
    _tag: "BharatCodeShareNextUnavailable",
    message: "BharatCode Share is not available in this beta.",
  })
}

describe("shipped-disabled ShareNext", () => {
  test("has no activation input in Product Core", () => {
    expect(SHARE_NEXT_ENABLED).toBe(false)
  })

  test("fails every public lifecycle entry before URL, token, snapshot, or fetch work", async () => {
    let shareRequests = 0
    globalThis.fetch = (async () => {
      shareRequests++
      throw new Error("ShareNext must fail before fetch")
    }) as unknown as typeof fetch
    process.env.BHARATCODE_SHARE_BASE_URL = "not a URL"
    process.env.BHARATCODE_SHARE_ACCESS_TOKEN = "must-not-be-read"
    const sessionID = SessionID.make("ses_sharenext_disabled")

    await expectUnavailable(ShareNext.use.url())
    await expectUnavailable(ShareNext.use.request())
    await expectUnavailable(ShareNext.use.create(sessionID))
    await expectUnavailable(ShareNext.use.remove(sessionID))

    expect(shareRequests).toBe(0)
  })
})
