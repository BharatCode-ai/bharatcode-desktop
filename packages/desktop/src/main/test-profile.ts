import path from "node:path"

/** Only the existing explicit diagnostic mode may change installed profile paths. */
export function testProfile(env: NodeJS.ProcessEnv, temp: string, nonce: string, platform = process.platform) {
  if (env.BHARATCODE_TEST_ONBOARDING !== "1" && env.OPENCODE_TEST_ONBOARDING !== "1") return
  const paths = platform === "win32" ? path.win32 : path.posix
  const root = env.OPENCODE_TEST_HOME ?? paths.join(temp, `bharatcode-onboarding-${nonce}`)
  if (!paths.isAbsolute(root)) throw new Error("invalid_test_home")
  return {
    root,
    desktop: paths.join(root, "desktop"),
    session: paths.join(root, "session"),
    documents: paths.join(root, "documents"),
    env: {
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: ":memory:", // Never import existing chat databases during a diagnostic launch.
      XDG_DATA_HOME: paths.join(root, "data"),
      XDG_CONFIG_HOME: paths.join(root, "config"),
      XDG_CACHE_HOME: paths.join(root, "cache"),
      XDG_STATE_HOME: paths.join(root, "state"),
      APPDATA: paths.join(root, "roaming"),
      LOCALAPPDATA: paths.join(root, "local"),
    },
  }
}
