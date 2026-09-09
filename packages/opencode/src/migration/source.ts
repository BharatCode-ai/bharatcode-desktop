import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

export type MigrationSource = {
  id: string
  label: string
  kind: "bharatcode-current" | "bharatcode-desktop" | "opencode-cli" | "opencode-desktop"
  roots: { data?: string; config?: string; desktop?: string }
}

export type MigrationChoice = { id: string; contentFingerprint: string }

export type DiscoveryInput = {
  platform: "linux" | "darwin" | "win32"
  home: string
  env: Readonly<Record<string, string | undefined>>
  destinationRoots: readonly string[]
}

export class MigrationSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BharatCodeMigrationSourceError"
  }
}

type Candidate = Pick<MigrationSource, "kind" | "roots">
type RootName = keyof MigrationSource["roots"]

export async function discoverMigrationSources(input: DiscoveryInput): Promise<readonly MigrationSource[]> {
  requireAbsolute(input.home, "home")
  input.destinationRoots.forEach((root) => requireAbsolute(root, "destination root"))
  const destinationRoots = await Promise.all(input.destinationRoots.map(canonicalIfPresent))
  const identities = new Set<string>()
  const sources = await Promise.all(
    candidates(input).map(async (candidate) => {
      const entries = await Promise.all(
        Object.entries(candidate.roots).map(async ([name, root]) => {
          if (!root) return
          const inspected = await inspectRoot(root, input.platform)
          if (!inspected) return
          if (destinationRoots.some((destination) => overlaps(inspected.identity, destination))) {
            throw new MigrationSourceError("A migration source overlaps the BharatCode destination.")
          }
          if (identities.has(inspected.identity)) {
            throw new MigrationSourceError("Migration discovery found a duplicate physical root.")
          }
          identities.add(inspected.identity)
          return [name as RootName, inspected.path, inspected.identity] as const
        }),
      )
      const present = entries.filter((entry) => entry !== undefined)
      if (present.length === 0) return
      const identity = present
        .map(([name, , physical]) => `${name}\0${physical}`)
        .toSorted()
        .join("\0")
      const digest = createHash("sha256").update(`${candidate.kind}\0${identity}`).digest("hex")
      return {
        id: `${candidate.kind}-${digest}`,
        label: `Existing BharatCode data · ${candidate.kind} · ${digest.slice(0, 8)}`,
        kind: candidate.kind,
        roots: Object.fromEntries(present.map(([name, root]) => [name, root])),
      } satisfies MigrationSource
    }),
  )
  return sources.filter((source) => source !== undefined).toSorted((left, right) => left.id.localeCompare(right.id))
}

function candidates(input: DiscoveryInput): readonly Candidate[] {
  const data = closedRoot(input.env.XDG_DATA_HOME, path.join(input.home, ".local", "share"), "XDG_DATA_HOME")
  const config = closedRoot(input.env.XDG_CONFIG_HOME, path.join(input.home, ".config"), "XDG_CONFIG_HOME")
  const desktop =
    input.platform === "darwin"
      ? path.join(input.home, "Library", "Application Support")
      : input.platform === "win32"
        ? closedRoot(input.env.APPDATA, path.join(input.home, "AppData", "Roaming"), "APPDATA")
        : data
  return [
    { kind: "bharatcode-current", roots: { data: path.join(data, "bharatcode"), config: path.join(config, "bharatcode") } },
    { kind: "bharatcode-desktop", roots: { desktop: path.join(input.home, ".bharatcode") } },
    { kind: "opencode-cli", roots: { data: path.join(data, "opencode"), config: path.join(config, "opencode") } },
    { kind: "opencode-desktop", roots: { desktop: path.join(desktop, "ai.opencode.desktop") } },
  ]
}

function closedRoot(value: string | undefined, fallback: string, name: string) {
  const root = value?.trim() || fallback
  requireAbsolute(root, name)
  return path.normalize(root)
}

function requireAbsolute(value: string, name: string) {
  if (!path.isAbsolute(value)) throw new MigrationSourceError(`${name} must be an absolute path.`)
}

async function inspectRoot(root: string, platform: DiscoveryInput["platform"]) {
  requireAbsolute(root, "source root")
  const info = await lstat(root).catch((error) => {
    if (nodeError(error, "ENOENT")) return undefined
    throw new MigrationSourceError("BharatCode could not inspect a migration source root.")
  })
  if (!info) return
  if (info.isSymbolicLink()) throw new MigrationSourceError("A migration source root is an unsupported link.")
  if (!info.isDirectory()) throw new MigrationSourceError("A migration source root is not a directory.")
  // Node's POSIX execute bits are not meaningful for Windows directories.
  // Applying the Unix 0500 check there rejects ordinary private AppData roots.
  if (platform !== "win32" && (info.mode & 0o500) !== 0o500) {
    throw new MigrationSourceError("A migration source root is not privately readable.")
  }
  const identity = await realpath(root).catch(() => {
    throw new MigrationSourceError("BharatCode could not resolve a migration source root.")
  })
  return { path: path.normalize(root), identity: normalizeIdentity(identity) }
}

async function canonicalIfPresent(root: string) {
  return normalizeIdentity(await realpath(root).catch(() => path.resolve(root)))
}

function normalizeIdentity(value: string) {
  const normalized = path.normalize(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function overlaps(left: string, right: string) {
  const relative = path.relative(left, right)
  const reverse = path.relative(right, left)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) || (!reverse.startsWith("..") && !path.isAbsolute(reverse))
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

export * as MigrationSourceDiscovery from "./source"
