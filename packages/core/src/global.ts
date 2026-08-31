import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { InstallationChannel } from "./installation/version"
import { StoragePaths } from "./storage-paths"
import { windowsCredentialStore } from "./util/windows-credential-store"

const resolved = StoragePaths.resolve({
  channel: process.env.BHARATCODE_CHANNEL ?? InstallationChannel,
  platform: process.platform,
  home: process.env.OPENCODE_TEST_HOME ?? os.homedir(),
  temp: os.tmpdir(),
  env: process.env,
})

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  ...resolved,
}

export const Path = paths

Flock.setGlobal({ state: Path.state })

export async function ensure() {
  if (process.platform === "win32") windowsCredentialStore(Path.auth).prepareParent()
  await Promise.all(
    [Path.data, Path.config, Path.state, Path.tmp, Path.log, Path.bin, Path.repos, Path.storage].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
  readonly channel: StoragePaths.Channel
  readonly storage: string
  readonly auth: string
  readonly database: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.BHARATCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    channel: Path.channel,
    storage: Path.storage,
    auth: Path.auth,
    database: Path.database,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
