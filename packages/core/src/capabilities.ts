import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Flock } from "./util/flock"
import { windowsCredentialStore } from "./util/windows-credential-store"
import type { ConfigV1 } from "./v1/config/config"
import type { ConfigMCPV1 } from "./v1/config/mcp"
import catalogData from "./capabilities/catalog.json"
import superpowers from "./capabilities/superpowers.json"

export const catalog = catalogData
export type Action = "install" | "enable" | "disable" | "uninstall"
export type State = { version: 1; installed: Record<string, { enabled: boolean }> }
type Stored = State & { legacy?: string[] }
const known = new Map(catalog.map((item) => [item.id, item]))
const bundleID = createHash("sha256").update(JSON.stringify(superpowers)).digest("hex").slice(0, 16)
const unavailable = () => new Error("Capability state is unavailable. Re-read state before retrying.")
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

function parse(text: string): Stored {
  if (text.length > 64 * 1024) throw unavailable()
  const value: unknown = JSON.parse(text)
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("installed" in value) ||
    !value.installed ||
    typeof value.installed !== "object" ||
    Array.isArray(value.installed)
  )
    throw unavailable()
  const installed: State["installed"] = {}
  for (const [id, entry] of Object.entries(value.installed)) {
    if (
      !known.has(id) ||
      !entry ||
      typeof entry !== "object" ||
      typeof entry.enabled !== "boolean" ||
      Object.keys(entry).some((key) => key !== "enabled")
    )
      throw unavailable()
    installed[id] = { enabled: entry.enabled }
  }
  if (
    "legacy" in value &&
    (!Array.isArray(value.legacy) || value.legacy.some((id) => typeof id !== "string" || !known.has(id)))
  )
    throw unavailable()
  return { version: 1, installed, ...("legacy" in value ? { legacy: value.legacy as string[] } : {}) }
}

function legacyState(value: unknown): Stored {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("installed" in value) ||
    !value.installed ||
    typeof value.installed !== "object" ||
    Array.isArray(value.installed)
  )
    throw unavailable()
  const installed: State["installed"] = { "superpowers-obra": { enabled: true } }
  for (const [id, record] of Object.entries(value.installed)) {
    if (
      !known.has(id) ||
      !record ||
      typeof record !== "object" ||
      record.id !== id ||
      typeof record.enabled !== "boolean"
    )
      throw unavailable()
    installed[id] = { enabled: record.enabled }
  }
  return { version: 1, installed, legacy: Object.keys(installed) }
}

const publicState = (state: Stored): State => ({ version: 1, installed: state.installed })

// Project only configuration facts, never credentials, endpoints or process
// arguments. These defaults are not proof that an MCP connection is healthy.
export function configuration(state: State, config: typeof ConfigV1.Info.Type, data: string) {
  return Object.fromEntries(
    catalog.map((item) => {
      const desired = state.installed[item.id]?.enabled === true
      const modules = item.modules.map((module) => {
        if (module.type === "mcp" && "name" in module && "config" in module) {
          const actual = config.mcp?.[module.name]
          const enabled = !!actual && "type" in actual && actual.enabled !== false
          const matching =
            !!actual && isDeepStrictEqual({ ...actual, enabled: true }, { ...module.config, enabled: true })
          return { enabled, custom: actual ? !desired || !enabled || !matching : desired }
        }
        const directory = path.join(data, "capabilities", `superpowers-${bundleID}`, "skills")
        const enabled = config.skills?.paths?.includes(directory) === true
        return { enabled, custom: enabled !== desired }
      })
      return [
        item.id,
        { enabled: modules.every((entry) => entry.enabled), custom: modules.some((entry) => entry.custom) },
      ]
    }),
  )
}

async function ensureDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
}

async function materialize(data: string) {
  await ensureDirectory(data)
  const root = path.join(data, "capabilities")
  await ensureDirectory(root)
  const bundle = path.join(root, `superpowers-${bundleID}`)
  await ensureDirectory(bundle)
  for (const [relative, text] of Object.entries(superpowers)) {
    const segments = relative.split("/")
    if (segments.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":")))
      throw unavailable()
    let directory = bundle
    for (const part of segments.slice(0, -1)) {
      directory = path.join(directory, part)
      await ensureDirectory(directory)
    }
    const file = path.join(bundle, relative)
    const stat = await fs.lstat(file).catch((error) => {
      if (!missing(error)) throw error
    })
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (await fs.readFile(file, "utf8")) !== text)
        throw unavailable()
      continue
    }
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, "wx", text.startsWith("#!") ? 0o700 : 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  return path.join(bundle, "skills")
}

export function store(options: { data: string; desktop: boolean }) {
  const file = path.join(options.data, "bharatcode-capabilities.json")
  const lockDirectory = path.join(options.data, "capabilities-locks")
  const defaults = (): State => ({
    version: 1,
    installed: options.desktop ? { "superpowers-obra": { enabled: true } } : {},
  })
  const loaded = (text: string): Stored => {
    const parsed = parse(text)
    return { ...parsed, installed: { ...defaults().installed, ...parsed.installed } }
  }
  const readStored = async (): Promise<Stored | undefined> => {
    try {
      if (process.platform === "win32") {
        const text = windowsCredentialStore(file).read()
        return text === undefined ? undefined : loaded(text)
      }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
        if (!missing(error)) throw error
      })
      if (!handle) return
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 64 * 1024 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw unavailable()
        return loaded(await handle.readFile("utf8"))
      } finally {
        await handle.close()
      }
    } catch {
      throw unavailable()
    }
  }
  const read = async (): Promise<State> => publicState((await readStored()) ?? defaults())
  const publish = async (state: Stored) => {
    const content = JSON.stringify(state, null, 2) + "\n"
    if (process.platform === "win32") {
      const native = windowsCredentialStore(file)
      native.prepareParent()
      native.publish(content)
      return
    }
    await ensureDirectory(options.data)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(content)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, file)
      const directory = await fs.open(options.data, "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  const change = async (id: string, action: Action) => {
    const item = known.get(id)
    if (!item) throw new Error("Unknown BharatCode capability.")
    if (!["install", "enable", "disable", "uninstall"].includes(action)) throw new Error("Invalid capability action.")
    try {
      // Prepare only newly owned storage before the lock can create ancestors.
      // The native helper rejects unsafe existing ACLs; it never rewrites them.
      if (process.platform === "win32") windowsCredentialStore(file).prepareParent()
      return await Flock.withLock(
        file,
        async () => {
          const state = (await readStored()) ?? defaults()
          if (action === "uninstall" && item.trust !== "bundled") delete state.installed[id]
          else if (action !== "install" || !state.installed[id])
            state.installed[id] = {
              enabled: action === "enable" || (action === "install" && item.defaultEnabled === true),
            }
          await publish(state)
          return publicState(state)
        },
        { dir: lockDirectory, timeoutMs: 10_000 },
      )
    } catch {
      throw unavailable()
    }
  }
  const migrate = async (legacy: unknown) => {
    if (legacy === undefined) return
    if (!options.desktop) throw unavailable()
    try {
      if (process.platform === "win32") windowsCredentialStore(file).prepareParent()
      await Flock.withLock(
        file,
        async () => {
          // An existing record also serves as the atomic migration receipt. Never
          // replay old choices after a successful publication or later user edit.
          if (await readStored()) return
          const value: unknown = typeof legacy === "function" ? await legacy() : legacy
          if (value !== undefined) await publish(legacyState(value))
        },
        { dir: lockDirectory, timeoutMs: 10_000 },
      )
    } catch {
      throw unavailable()
    }
  }
  const filterLegacy = async (input: typeof ConfigV1.Info.Type): Promise<ConfigV1.Info> => {
    const config = structuredClone(input) as ConfigV1.Info
    const state = await readStored()
    if (!state?.legacy) return config
    const mcp = { ...config.mcp }
    for (const id of state.legacy) {
      for (const module of known.get(id)!.modules) {
        if (module.type !== "mcp" || !("name" in module) || !("config" in module)) continue
        // Only the predecessor's exact generated shape is owned. Custom URLs,
        // headers, environment, disabled overrides and extra options win.
        if (isDeepStrictEqual(mcp[module.name], { ...module.config, enabled: true })) delete mcp[module.name]
      }
    }
    const paths = config.skills?.paths?.filter(
      (value) =>
        !state.legacy!.includes("superpowers-obra") ||
        !value.replace(/\\/g, "/").endsWith("/resources/capabilities/superpowers/skills"),
    )
    return {
      ...config,
      ...(config.mcp ? { mcp } : {}),
      ...(paths ? { skills: { ...config.skills, paths } } : {}),
    }
  }
  const overlay = async (): Promise<ConfigV1.Info> => {
    const state = await read()
    const result: ConfigV1.Info = { mcp: {}, skills: { paths: [] } }
    for (const [id, entry] of Object.entries(state.installed)) {
      if (!entry.enabled) continue
      const item = known.get(id)!
      for (const module of item.modules) {
        if (module.type === "mcp" && "name" in module && "config" in module)
          result.mcp![module.name] = { ...module.config, enabled: true } as ConfigMCPV1.Info
        if (module.type === "skill")
          result.skills!.paths!.push(
            await Flock.withLock("superpowers", () => materialize(options.data), {
              dir: lockDirectory,
              timeoutMs: 10_000,
            }),
          )
      }
    }
    return result
  }
  return { read, change, overlay, migrate, filterLegacy }
}

// Only the native Desktop startup path supplies its own Electron userData root.
// WSL and remote runtimes never inherit a Windows host's marketplace choices.
export async function migrateDesktop(options: { data: string; userData: string }) {
  await store({ data: options.data, desktop: true }).migrate(async () => {
    const file = path.join(options.userData, "bharatcode.capabilities")
    const text = await (async () => {
      if (process.platform === "win32") return windowsCredentialStore(file).read()
      const parent = await fs.lstat(options.userData).catch((error) => {
        if (!missing(error)) throw error
      })
      if (!parent) return
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (parent.mode & 0o022) !== 0 ||
        (process.getuid && parent.uid !== process.getuid())
      )
        throw unavailable()
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
        if (!missing(error)) throw error
      })
      if (!handle) return
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 64 * 1024 ||
          (stat.mode & 0o022) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw unavailable()
        return await handle.readFile("utf8")
      } finally {
        await handle.close()
      }
    })()
    if (text === undefined) return
    if (text.length > 64 * 1024) throw unavailable()
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable()
    return "state.v1" in value ? value["state.v1"] : undefined
  })
}

export * as Capabilities from "./capabilities"
