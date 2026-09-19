import path from "node:path"

export type Channel = "prod" | "beta" | "dev" | "local" | "test"

export type Input = {
  readonly channel?: string
  /**
   * Overrides the directory name derived from the channel. Used to address an
   * installation that predates the current naming, so the import engine can
   * still find it.
   */
  readonly name?: string
  readonly platform: string
  readonly home: string
  readonly temp: string
  readonly env?: Record<string, string | undefined>
}

export function normalizeChannel(channel: string | undefined): Channel {
  if (channel === "prod" || channel === "latest") return "prod"
  if (channel === "beta" || channel === "next") return "beta"
  if (channel === "dev") return "dev"
  if (channel === "test") return "test"
  return "local"
}

/**
 * The on-disk directory name for a channel, matching the desktop product name
 * (productNameForChannel in desktop/src/main/branding.ts). Electron derives its
 * own paths from productName the same way, so using it here keeps the CLI and
 * the app pointed at one directory instead of two, and it reads correctly in
 * Finder and Explorer.
 */
/**
 * Directory names used before the move to the product name. Shipped releases
 * wrote here, so the import engine still has to be able to find them.
 */
export const LEGACY_NAMES = Object.freeze(["bharatcode", "bharatcode-beta", "bharatcode-dev", "bharatcode-local"])

export function displayName(channel: Channel) {
  if (channel === "prod") return "BharatCode"
  return `BharatCode ${channel.charAt(0).toUpperCase()}${channel.slice(1)}`
}

export function resolve(input: Input) {
  const channel = normalizeChannel(input.channel)
  const name = input.name ?? displayName(channel)
  const paths = input.platform === "win32" ? path.win32 : path.posix
  const env = input.env ?? {}
  const roots =
    input.platform === "darwin"
      ? {
          data: paths.join(input.home, "Library", "Application Support", name),
          config: paths.join(input.home, "Library", "Preferences", name),
          cache: paths.join(input.home, "Library", "Caches", name),
          state: paths.join(input.home, "Library", "Application Support", name, "State"),
          log: paths.join(input.home, "Library", "Logs", name),
        }
      : input.platform === "win32"
        ? {
            data: paths.join(env.LOCALAPPDATA ?? paths.join(input.home, "AppData", "Local"), name, "Data"),
            config: paths.join(env.APPDATA ?? paths.join(input.home, "AppData", "Roaming"), name, "Config"),
            cache: paths.join(env.LOCALAPPDATA ?? paths.join(input.home, "AppData", "Local"), name, "Cache"),
            state: paths.join(env.LOCALAPPDATA ?? paths.join(input.home, "AppData", "Local"), name, "State"),
            log: paths.join(env.LOCALAPPDATA ?? paths.join(input.home, "AppData", "Local"), name, "Log"),
          }
        : (() => {
            const data = paths.join(env.XDG_DATA_HOME ?? paths.join(input.home, ".local", "share"), name)
            const state = paths.join(env.XDG_STATE_HOME ?? paths.join(input.home, ".local", "state"), name)
            return {
              data,
              config: paths.join(env.XDG_CONFIG_HOME ?? paths.join(input.home, ".config"), name),
              cache: paths.join(env.XDG_CACHE_HOME ?? paths.join(input.home, ".cache"), name),
              state,
              log: paths.join(state, "log"),
            }
          })()

  return {
    channel,
    data: roots.data,
    cache: roots.cache,
    config: roots.config,
    state: roots.state,
    // Recovery snapshots and journals must be disjoint from the destination
    // data/config roots. macOS keeps ordinary app state below data, so use a
    // branded sibling solely for the recovery transaction there.
    recovery:
      input.platform === "darwin"
        ? paths.join(input.home, "Library", "Application Support", `${name} Recovery`)
        : roots.state,
    tmp: paths.join(input.temp, name),
    bin: paths.join(roots.cache, "bin"),
    log: roots.log,
    repos: paths.join(roots.data, "repos"),
    storage: paths.join(roots.data, "storage"),
    auth: paths.join(roots.data, "auth.json"),
    database: paths.join(roots.data, "bharatcode.db"),
  }
}

export * as StoragePaths from "./storage-paths"
