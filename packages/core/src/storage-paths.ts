import path from "node:path"

export type Channel = "prod" | "beta" | "dev" | "local" | "test"

export type Input = {
  readonly channel?: string
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

export function resolve(input: Input) {
  const channel = normalizeChannel(input.channel)
  const name = `bharatcode${channel === "prod" ? "" : `-${channel}`}`
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
