import { expect, test } from "bun:test"
import { createSupportErrors } from "./support-errors"
import { supportErrorCategories } from "./support-bundle"

test("records fixed categories only, with no error payload or private keys", () => {
  const errors = createSupportErrors(() => 0)
  expect(Object.values(errors.summary()).every((count) => count === 0)).toBe(true)
  for (const category of supportErrorCategories) errors.record(category)
  Reflect.apply(errors.record, null, ["private-token", { message: "sk-secret" }])
  expect(errors.summary()).toEqual(Object.fromEntries(supportErrorCategories.map((category) => [category, 1])))
  const copy = errors.summary()
  copy.sidecar = 200
  expect(errors.summary().sidecar).toBe(1)
})

test("expires entries at 24 hours and retains at most the most recent 200", () => {
  let now = 0
  const errors = createSupportErrors(() => now)
  errors.record("startup")
  now = 24 * 60 * 60 * 1000
  expect(errors.summary().startup).toBe(0)
  for (let n = 0; n < 201; n++) errors.record("sidecar")
  errors.record("network")
  expect(errors.summary().sidecar).toBe(199)
  expect(errors.summary().network).toBe(1)
})

test("real auth and updater failures record only their fixed category", async () => {
  const { supportErrors } = await import("./support-errors")
  const { createUpdaterController } = await import("./updater-controller")
  const { createAccountSession } = await import("./account-session")
  const before = supportErrors.summary()
  const secret = new Error("sk-private owner@private.test https://private.test/repo")
  const updater = createUpdaterController({ enabled: true, currentVersion: "1.0.0", backend: { checkForUpdates: async () => { throw secret }, downloadUpdate: async () => {}, quitAndInstall: () => {} }, persistence: { get: () => undefined, set: () => {}, clear: () => {} }, stop: async () => {} })
  expect((await updater.check()).status).toBe("error")
  const account = createAccountSession({ client: { getAccountStatus: async () => { throw secret }, beginSignIn: async () => { throw secret }, completeSignIn: async () => { throw secret }, logout: async () => { throw secret } }, openBrowser: async () => {}, changed: () => {} })
  await expect(account.getAccountStatus()).rejects.toThrow()
  account.dispose()
  expect(supportErrors.summary().authentication).toBe(before.authentication + 1)
  expect(supportErrors.summary().update).toBe(before.update + 1)
  expect(JSON.stringify(supportErrors.summary())).not.toContain("sk-private")
})
