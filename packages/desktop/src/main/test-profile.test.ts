import { expect, test } from "bun:test"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { testProfile } from "./test-profile"
import { shouldRegisterProtocol } from "./branding"

test("ordinary launches do not opt into diagnostic profile overrides", () => {
  expect(testProfile({ OPENCODE_TEST_HOME: "C:\\test" }, "C:\\Temp", "one", "win32")).toBeUndefined()
})

test("Windows diagnostics isolate credentials, chat data and Electron state and reuse the same callback profile", () => {
  const root = "C:\\Temp\\bharatcode-auth-test-synthetic"
  const env = {
    BHARATCODE_TEST_ONBOARDING: "1",
    OPENCODE_TEST_HOME: root,
    APPDATA: "C:\\Users\\synthetic\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\synthetic\\AppData\\Local",
  }
  const profile = testProfile(env, "C:\\Temp", "one", "win32")!
  expect(testProfile(env, "C:\\Temp", "two", "win32")).toEqual(profile)
  const storage = StoragePaths.resolve({ platform: "win32", channel: "beta", home: root, temp: root, env: profile.env })
  for (const value of [
    profile.desktop,
    profile.session,
    profile.documents,
    storage.auth,
    storage.database,
    storage.config,
    storage.state,
  ])
    expect(value.startsWith(`${root}\\`)).toBe(true)
  expect(profile.env.OPENCODE_DB).toBe(":memory:")
  expect(shouldRegisterProtocol({ packaged: true, channel: "beta", diagnostic: true })).toBe(false)
  expect(env.APPDATA).toBe("C:\\Users\\synthetic\\AppData\\Roaming")
})

test("unconfigured diagnostics remain fresh and a relative test home fails closed", () => {
  const env = { OPENCODE_TEST_ONBOARDING: "1" }
  expect(testProfile(env, "/tmp", "one", "linux")!.root).not.toBe(testProfile(env, "/tmp", "two", "linux")!.root)
  expect(() => testProfile({ ...env, OPENCODE_TEST_HOME: "relative" }, "/tmp", "one", "linux")).toThrow(
    "invalid_test_home",
  )
})
