import { execFile } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { createSidecarAuthorizationPolicy } from "./sidecar-auth"
import type { BharatCodeSidecarConnection } from "./bharatcode-auth"

const exec = promisify(execFile)

type RelayStatus = {
  relay?: { running?: boolean; stale?: boolean; error?: string }
  extension?: { connected?: boolean }
}
type BrowseConfigResponse = {
  mcp?: Record<
    string,
    {
      type?: string
      command?: string[]
      enabled?: boolean
      environment?: Record<string, string>
    }
  >
}

export type BrowseAction = "setup" | "check"
export type BrowseResult =
  | { state: "unavailable" | "waiting" | "failed" }
  | { state: "pairing"; folder: string; code: string }
  | { state: "connected"; command: string[]; environment: Record<string, string> }

export function createBrowseSetup(resources: () => string, userData: () => string) {
  const runtime = createBrowseRuntime(resources, userData)
  return (action: unknown): Promise<BrowseResult> => {
    if (action !== "setup" && action !== "check") return Promise.resolve({ state: "failed" })
    return runtime(action)
  }
}

function createBrowseRuntime(resources: () => string, userData: () => string) {
  let pending: Promise<BrowseResult> | undefined

  return (action: BrowseAction | "upgrade", previousCommand?: string): Promise<BrowseResult> => {
    if (pending) return Promise.resolve({ state: "waiting" })
    pending = run(action, previousCommand)
      .catch(() => ({ state: "failed" as const }))
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  async function run(action: BrowseAction | "upgrade", previousCommand?: string): Promise<BrowseResult> {
    const source = join(resources(), "bharatcode-browse")
    const bundle = await readFile(join(source, "bundle-id"), "utf8").catch(() => "")
    const id = bundle.trim()
    if (!/^[a-f0-9]{64}$/.test(id)) return { state: "unavailable" }

    const root = join(userData(), "browse")
    const runtime = join(root, id)
    const filename = process.platform === "win32" ? "browse.exe" : "browse"
    const binary = join(runtime, filename)
    const folder = join(runtime, "extension")
    if (previousCommand === binary) return { state: "waiting" }
    if (!(await stat(binary).catch(() => undefined))) {
      if (action === "check") return { state: "waiting" }
      await mkdir(root, { recursive: true, mode: 0o700 })
      const temporary = await mkdtemp(join(root, ".install-"))
      try {
        await cp(source, temporary, { recursive: true })
        await rename(temporary, runtime).catch(async (error: unknown) => {
          if (!(await stat(binary).catch(() => undefined))) throw error
        })
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }

    const environment = {
      OPENCODE_BROWSER_HOME: join(root, "relay"),
      OPENCODE_BROWSER_PORT: "19989",
      OPENCODE_BROWSER_AUTO_UPDATE: "off",
      OPENCODE_BROWSER_UPDATE_CHECK: "0",
      OPENCODE_BROWSER_MCP_DIRECT: "1",
    }
    const options = { env: { ...process.env, ...environment }, timeout: 35_000, windowsHide: true }
    const getStatus = async (): Promise<RelayStatus | undefined> => {
      const result = await exec(binary, ["status", "--json"], options).catch((error: { stdout?: string }) => error)
      return result.stdout ? JSON.parse(result.stdout) : undefined
    }
    let current = await getStatus()
    if (current?.relay?.stale === true) {
      // The relay refuses an unsafe restart while browser work is active.
      await exec(binary, ["relay", "restart"], options)
      current = await getStatus()
      if (current?.relay?.running !== true || current.relay.stale) return { state: "failed" }
    }
    if (action === "upgrade" && (!current?.relay || current.relay.error)) return { state: "failed" }
    if (action === "upgrade" || current?.extension?.connected === true) {
      return { state: "connected", command: [binary, "mcp"], environment }
    }
    if (action === "check") return { state: "waiting" }

    const result = await exec(binary, ["pair", "--code-only"], options)
    const code = result.stdout.trim()
    if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code)) return { state: "failed" }
    return { state: "pairing", folder, code }
  }
}

/** Migrate only the Desktop-managed entry. Existing pairings live outside the versioned bundle. */
export async function upgradeBundledBrowse(
  resources: string,
  userData: string,
  connection: BharatCodeSidecarConnection,
) {
  if (!(await stat(join(resources, "bharatcode-browse", "bundle-id")).catch(() => undefined))) return
  const policy = createSidecarAuthorizationPolicy({
    origin: connection.url,
    username: connection.username,
    password: connection.password,
  })
  const url = new URL("/global/config", policy.origin)
  const headers = policy.authorize(url.href, new Headers({ "content-type": "application/json" }))
  const request = (method: "GET" | "PATCH", body?: string) =>
    fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(5_000) })
  const response = await request("GET")
  if (!response.ok) throw new Error("Could not read the Desktop MCP configuration")
  const config: BrowseConfigResponse = await response.json()
  const current = config.mcp?.["bharatcode-browse"]
  const root = join(userData, "browse")
  if (
    current?.type !== "local" ||
    current.enabled === false ||
    current.environment?.OPENCODE_BROWSER_HOME !== join(root, "relay")
  )
    return
  const command = current.command
  if (!Array.isArray(command) || command.length !== 2 || command[1] !== "mcp") return
  const binary = command[0]
  if (typeof binary !== "string" || basename(binary) !== (process.platform === "win32" ? "browse.exe" : "browse"))
    return
  if (dirname(dirname(binary)) !== root || !/^[a-f0-9]{64}$/.test(dirname(binary).slice(root.length + 1))) return

  const staged = await createBrowseRuntime(
    () => resources,
    () => userData,
  )("upgrade", binary)
  if (staged.state === "waiting") return
  if (staged.state !== "connected") throw new Error("Could not stage the bundled Browse upgrade")
  const latest = await request("GET")
  if (!latest.ok) throw new Error("Could not recheck the Desktop MCP configuration")
  const latestConfig: BrowseConfigResponse = await latest.json()
  if (JSON.stringify(latestConfig.mcp?.["bharatcode-browse"]) !== JSON.stringify(current)) return
  const updated = await request(
    "PATCH",
    JSON.stringify({
      mcp: {
        "bharatcode-browse": {
          type: "local",
          command: staged.command,
          environment: staged.environment,
        },
      },
    }),
  )
  if (!updated.ok) throw new Error("Could not register the bundled Browse upgrade")
}
