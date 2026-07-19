import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const opencodeConfigPath = (home = process.env.BHARATCODE_HOME || homedir()) =>
  join(home, ".config", "opencode", "opencode.jsonc")

export type CapabilityTrust = "bundled" | "curated" | "local"
export type CapabilityStatus = "available" | "installed" | "enabled" | "needs_setup" | "unhealthy" | "update_available"
export type CapabilityCategory =
  | "workflow"
  | "code-hosting"
  | "browser"
  | "design"
  | "planning"
  | "monitoring"
  | "database"
  | "billing"
  | "docs"

export type CapabilityPermission =
  | "workspace_files"
  | "local_process"
  | "browser_automation"
  | "oauth_account"
  | "network"
  | "env_vars"
  | "background_process"
  | "billing_data"
  | "database_data"
  | "deployment_data"
  | "monitoring_data"

export type CapabilityMcpConfig =
  | {
      type: "remote"
      url: string
      enabled?: boolean
      headers?: Record<string, string>
      oauth?:
        | false
        | { clientId?: string; clientSecret?: string; scope?: string; callbackPort?: number; redirectUri?: string }
      timeout?: number
    }
  | {
      type: "local"
      command: string[]
      environment?: Record<string, string>
      enabled?: boolean
      timeout?: number
    }

export type CapabilityModule =
  | { type: "skill"; id: "superpowers"; path: "bundled-superpowers" }
  | { type: "mcp"; name: string; config: CapabilityMcpConfig }
  | { type: "connector"; name: string }
  | { type: "prompt"; name: string }
  | { type: "surface"; name: string }

export type CapabilityCatalogItem = {
  id: string
  name: string
  description: string
  publisher: string
  version: string
  category: CapabilityCategory
  trust: CapabilityTrust
  defaultEnabled?: boolean
  requiresSetup?: boolean
  requirements: string[]
  permissions: CapabilityPermission[]
  modules: CapabilityModule[]
}

export type CapabilityInstallRecord = {
  id: string
  version: string
  status: Exclude<CapabilityStatus, "available">
  enabled: boolean
  trust: CapabilityTrust
  installedAt: string
  updatedAt: string
  health?: {
    ok: boolean
    message?: string
    checkedAt: string
  }
}

export type CapabilityState = {
  version: 1
  installed: Record<string, CapabilityInstallRecord>
}

export type CapabilityRuntimeManifest = {
  skills: {
    paths: string[]
  }
  mcp: Record<string, CapabilityMcpConfig>
}

export type CapabilitySnapshot = {
  catalog: CapabilityCatalogItem[]
  state: CapabilityState
  runtime: CapabilityRuntimeManifest
}

export type CapabilityStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete?(key: string): void
}

export type CapabilityStoreFactory = (name?: string) => CapabilityStore

const CAPABILITY_STORE_NAME = "bharatcode.capabilities"
const CAPABILITY_STATE_KEY = "state.v1"

export const CAPABILITY_CATALOG: CapabilityCatalogItem[] = [
  {
    id: "superpowers-obra",
    name: "Superpowers by Obra",
    description: "Use Obra's development workflow skills inside BharatCode.",
    publisher: "Obra",
    version: "1.0.0",
    category: "workflow",
    trust: "bundled",
    defaultEnabled: true,
    requirements: [],
    permissions: ["workspace_files"],
    modules: [{ type: "skill", id: "superpowers", path: "bundled-superpowers" }],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Let BharatCode inspect pull requests, issues, Actions, releases, and repository metadata.",
    publisher: "GitHub",
    version: "1.0.0",
    category: "code-hosting",
    trust: "curated",
    requiresSetup: true,
    requirements: ["GitHub account", "Remote MCP OAuth"],
    permissions: ["oauth_account", "network"],
    modules: [
      {
        type: "mcp",
        name: "github",
        config: { type: "remote", url: "https://api.githubcopilot.com/mcp/" },
      },
    ],
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Use browser automation for screenshots, accessibility snapshots, and UI smoke tests.",
    publisher: "Microsoft",
    version: "1.0.0",
    category: "browser",
    trust: "curated",
    requiresSetup: true,
    requirements: ["Node.js 18 or newer", "npx available on PATH"],
    permissions: ["browser_automation", "local_process", "network", "background_process"],
    modules: [
      {
        type: "mcp",
        name: "playwright",
        config: { type: "local", command: ["npx", "@playwright/mcp@latest"] },
      },
    ],
  },
  {
    id: "figma",
    name: "Figma",
    description: "Add Figma design context for selected files and frames.",
    publisher: "Figma",
    version: "1.0.0",
    category: "design",
    trust: "curated",
    requiresSetup: true,
    requirements: ["Figma account", "Remote MCP OAuth"],
    permissions: ["oauth_account", "network"],
    modules: [
      {
        type: "mcp",
        name: "figma",
        config: { type: "remote", url: "https://mcp.figma.com/mcp" },
      },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Bring issues, projects, comments, and planning context into BharatCode.",
    publisher: "Linear",
    version: "1.0.0",
    category: "planning",
    trust: "curated",
    requiresSetup: true,
    requirements: ["Linear account", "Remote MCP OAuth"],
    permissions: ["oauth_account", "network"],
    modules: [
      {
        type: "mcp",
        name: "linear",
        config: { type: "remote", url: "https://mcp.linear.app/mcp" },
      },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Inspect errors, traces, releases, and issue context from Sentry.",
    publisher: "Sentry",
    version: "1.0.0",
    category: "monitoring",
    trust: "curated",
    requiresSetup: true,
    requirements: ["Sentry account", "Remote MCP OAuth"],
    permissions: ["oauth_account", "network", "monitoring_data"],
    modules: [
      {
        type: "mcp",
        name: "sentry",
        config: { type: "remote", url: "https://mcp.sentry.dev/mcp" },
      },
    ],
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Inspect project schema, migrations, logs, and SQL context after you connect Supabase.",
    publisher: "Supabase",
    version: "1.0.0",
    category: "database",
    trust: "curated",
    requiresSetup: true,
    requirements: ["Supabase account", "Remote MCP OAuth"],
    permissions: ["oauth_account", "network", "database_data"],
    modules: [
      {
        type: "mcp",
        name: "supabase",
        config: { type: "remote", url: "https://mcp.supabase.com/mcp" },
      },
    ],
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Inspect billing, product, customer, payment, and subscription context.",
    publisher: "Stripe",
    version: "1.0.0",
    category: "billing",
    trust: "curated",
    requiresSetup: true,
    requirements: ["Stripe account", "OAuth or restricted API key"],
    permissions: ["oauth_account", "network", "billing_data"],
    modules: [
      {
        type: "mcp",
        name: "stripe",
        config: { type: "remote", url: "https://mcp.stripe.com" },
      },
    ],
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare Docs",
    description: "Search current Cloudflare documentation without granting account access.",
    publisher: "Cloudflare",
    version: "1.0.0",
    category: "docs",
    trust: "curated",
    requirements: [],
    permissions: ["network"],
    modules: [
      {
        type: "mcp",
        name: "cloudflare-docs",
        config: { type: "remote", url: "https://docs.mcp.cloudflare.com/mcp", oauth: false },
      },
    ],
  },
]

const catalogById = new Map(CAPABILITY_CATALOG.map((item) => [item.id, item] as const))
const managedMcpNames = new Set(
  CAPABILITY_CATALOG.flatMap((item) => item.modules.flatMap((module) => (module.type === "mcp" ? [module.name] : []))),
)

function now(input?: string) {
  return input ?? new Date().toISOString()
}

function requireCatalogItem(id: string) {
  const item = catalogById.get(id)
  if (!item) throw new Error(`Unknown BharatCode capability: ${id}`)
  return item
}

function installRecord(
  item: CapabilityCatalogItem,
  input: { now?: string; enabled?: boolean },
): CapabilityInstallRecord {
  const time = now(input.now)
  const enabled = input.enabled ?? Boolean(item.defaultEnabled)
  return {
    id: item.id,
    version: item.version,
    trust: item.trust,
    enabled,
    status: enabled ? "enabled" : "installed",
    installedAt: time,
    updatedAt: time,
  }
}

function statusFor(item: CapabilityCatalogItem, enabled: boolean): CapabilityInstallRecord["status"] {
  if (!enabled) return "installed"
  if (item.requiresSetup) return "needs_setup"
  return "enabled"
}

export function createDefaultCapabilityState(options: { now?: string } = {}): CapabilityState {
  const installed: CapabilityState["installed"] = {}
  for (const item of CAPABILITY_CATALOG) {
    if (!item.defaultEnabled) continue
    installed[item.id] = installRecord(item, { now: options.now, enabled: true })
  }
  return { version: 1, installed }
}

export function installCapability(state: CapabilityState, id: string, options: { now?: string } = {}): CapabilityState {
  const item = requireCatalogItem(id)
  const existing = state.installed[id]
  if (existing) return state
  return {
    ...state,
    installed: {
      ...state.installed,
      [id]: installRecord(item, { now: options.now, enabled: Boolean(item.defaultEnabled) }),
    },
  }
}

export function setCapabilityEnabled(
  state: CapabilityState,
  id: string,
  enabled: boolean,
  options: { now?: string } = {},
): CapabilityState {
  const item = requireCatalogItem(id)
  const existing = state.installed[id] ?? installRecord(item, { now: options.now, enabled: false })
  const next: CapabilityInstallRecord = {
    ...existing,
    enabled,
    status: statusFor(item, enabled),
    updatedAt: now(options.now),
  }
  return {
    ...state,
    installed: {
      ...state.installed,
      [id]: next,
    },
  }
}

export function uninstallCapability(state: CapabilityState, id: string): CapabilityState {
  const item = requireCatalogItem(id)
  if (item.trust === "bundled") return setCapabilityEnabled(state, id, false)
  if (!state.installed[id]) return state
  const installed = { ...state.installed }
  delete installed[id]
  return { ...state, installed }
}

export function resolveCapabilityRuntime(
  state: CapabilityState,
  paths: { superpowersSkillsPath: string },
): CapabilityRuntimeManifest {
  const runtime: CapabilityRuntimeManifest = { skills: { paths: [] }, mcp: {} }

  for (const record of Object.values(state.installed)) {
    if (!record.enabled) continue
    const item = catalogById.get(record.id)
    if (!item) continue

    for (const module of item.modules) {
      if (module.type === "skill" && module.id === "superpowers") {
        runtime.skills.paths.push(paths.superpowersSkillsPath)
      }
      if (module.type === "mcp") {
        runtime.mcp[module.name] = { ...module.config, enabled: true } as CapabilityMcpConfig
      }
    }
  }

  return {
    skills: { paths: [...new Set(runtime.skills.paths)] },
    mcp: runtime.mcp,
  }
}

export function resolveBundledSuperpowersSkillsPath(resourcesPath: string) {
  return join(resourcesPath, "capabilities", "superpowers", "skills")
}

function isManagedSkillPath(path: string, managedSkillPaths: Set<string>) {
  if (managedSkillPaths.has(path)) return true
  return path.replace(/\\/g, "/").endsWith("/resources/capabilities/superpowers/skills")
}

export function createCapabilitySnapshot(
  state: CapabilityState,
  paths: { superpowersSkillsPath: string },
): CapabilitySnapshot {
  return {
    catalog: CAPABILITY_CATALOG,
    state,
    runtime: resolveCapabilityRuntime(state, paths),
  }
}

export function readCapabilityState(store: CapabilityStore, options: { now?: string } = {}): CapabilityState {
  const current = store.get(CAPABILITY_STATE_KEY)
  if (!current || typeof current !== "object") {
    const initial = createDefaultCapabilityState({ now: options.now })
    store.set(CAPABILITY_STATE_KEY, initial)
    return initial
  }

  const parsed = current as Partial<CapabilityState>
  const baseline = createDefaultCapabilityState({ now: options.now })
  return {
    version: 1,
    installed: {
      ...baseline.installed,
      ...parsed.installed,
    },
  }
}

export function writeCapabilityState(store: CapabilityStore, state: CapabilityState) {
  store.set(CAPABILITY_STATE_KEY, state)
}

export function getCapabilitySnapshotFromStore({
  getStore,
  resourcesPath,
  now: nowValue,
}: {
  getStore: CapabilityStoreFactory
  resourcesPath: string
  now?: string
}) {
  const store = getStore(CAPABILITY_STORE_NAME)
  const state = readCapabilityState(store, { now: nowValue })
  return createCapabilitySnapshot(state, {
    superpowersSkillsPath: resolveBundledSuperpowersSkillsPath(resourcesPath),
  })
}

export function installStoredCapability(input: {
  getStore: CapabilityStoreFactory
  resourcesPath: string
  id: string
  now?: string
}) {
  const store = input.getStore(CAPABILITY_STORE_NAME)
  const state = installCapability(readCapabilityState(store, { now: input.now }), input.id, { now: input.now })
  writeCapabilityState(store, state)
  return createCapabilitySnapshot(state, {
    superpowersSkillsPath: resolveBundledSuperpowersSkillsPath(input.resourcesPath),
  })
}

export function setStoredCapabilityEnabled(input: {
  getStore: CapabilityStoreFactory
  resourcesPath: string
  id: string
  enabled: boolean
  now?: string
}) {
  const store = input.getStore(CAPABILITY_STORE_NAME)
  const state = setCapabilityEnabled(readCapabilityState(store, { now: input.now }), input.id, input.enabled, {
    now: input.now,
  })
  writeCapabilityState(store, state)
  return createCapabilitySnapshot(state, {
    superpowersSkillsPath: resolveBundledSuperpowersSkillsPath(input.resourcesPath),
  })
}

export function uninstallStoredCapability(input: {
  getStore: CapabilityStoreFactory
  resourcesPath: string
  id: string
}) {
  const store = input.getStore(CAPABILITY_STORE_NAME)
  const state = uninstallCapability(readCapabilityState(store), input.id)
  writeCapabilityState(store, state)
  return createCapabilitySnapshot(state, {
    superpowersSkillsPath: resolveBundledSuperpowersSkillsPath(input.resourcesPath),
  })
}

function stripJsonComments(input: string) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1")
}

function readConfig(raw: string) {
  if (!raw.trim()) return {}
  return JSON.parse(stripJsonComments(raw))
}

function formatConfig(config: unknown) {
  return `${JSON.stringify(config, null, 2)}\n`
}

export async function applyCapabilityRuntimeToConfig({
  configPath,
  runtime,
  managedSkillPaths = [],
}: {
  configPath: string
  runtime: CapabilityRuntimeManifest
  managedSkillPaths?: string[]
}): Promise<{ changed: boolean }> {
  await mkdir(dirname(configPath), { recursive: true })
  let raw = ""
  try {
    raw = await readFile(configPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }

  const config = readConfig(raw)
  const target = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, any>) : {}
  const before = formatConfig(target)

  const currentSkills =
    target.skills && typeof target.skills === "object" && !Array.isArray(target.skills)
      ? (target.skills as Record<string, unknown>)
      : {}
  const currentPaths = Array.isArray(currentSkills.paths)
    ? currentSkills.paths.filter((item): item is string => typeof item === "string")
    : []
  const managed = new Set([...managedSkillPaths, ...runtime.skills.paths])
  target.skills = {
    ...currentSkills,
    paths: [
      ...new Set([
        ...currentPaths.filter((item: string) => !isManagedSkillPath(item, managed)),
        ...runtime.skills.paths,
      ]),
    ],
  }

  const currentMcp = target.mcp && typeof target.mcp === "object" && !Array.isArray(target.mcp) ? target.mcp : {}
  const nextMcp: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(currentMcp)) {
    if (!managedMcpNames.has(name)) nextMcp[name] = value
  }
  for (const [name, value] of Object.entries(runtime.mcp)) {
    nextMcp[name] = value
  }
  target.mcp = nextMcp

  const next = formatConfig(target)
  if (next === before && raw) return { changed: false }
  await writeFile(configPath, next, { mode: 0o600 })
  return { changed: true }
}

export async function ensureCapabilityRuntime({
  home = process.env.BHARATCODE_HOME || homedir(),
  resourcesPath,
  getStore,
}: {
  home?: string
  resourcesPath: string
  getStore: CapabilityStoreFactory
}) {
  const snapshot = getCapabilitySnapshotFromStore({ getStore, resourcesPath })
  const superpowersSkillsPath = resolveBundledSuperpowersSkillsPath(resourcesPath)
  await applyCapabilityRuntimeToConfig({
    configPath: opencodeConfigPath(home),
    runtime: snapshot.runtime,
    managedSkillPaths: [superpowersSkillsPath],
  })
  return snapshot
}
