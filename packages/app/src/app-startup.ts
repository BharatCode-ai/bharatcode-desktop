import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { latestRootSession } from "./pages/layout/helpers"
import { pathKey } from "./utils/path-key"

type StartupProject = {
  worktree?: string
}

function isFilesystemRoot(directory: string) {
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized === "" || normalized === "/" || /^[a-zA-Z]:$/.test(normalized)
}

export function resolveDesktopStartupChatDirectory(input: {
  platform: "web" | "desktop"
  ready: boolean
  projects: StartupProject[]
  lastProject?: string
  home?: string
}) {
  if (input.platform !== "desktop") return undefined
  if (!input.ready) return undefined

  const lastProject = input.lastProject?.trim()
  if (lastProject) {
    const known = input.projects.find((item) => item.worktree === lastProject)
    if (known || input.projects.length === 0) return lastProject
  }

  const project = input.projects.find((item) => item.worktree)?.worktree
  if (project) return project

  const home = input.home?.trim()
  if (home && !isFilesystemRoot(home)) return home
  return undefined
}

export function startupChatPath(directory: string, session?: { directory: string; id: string }) {
  return `/${base64Encode(session?.directory ?? directory)}/session${session ? `/${encodeURIComponent(session.id)}` : ""}`
}

export function createStartupRestoreGuard() {
  let attempt = 0
  return {
    begin(eligible: () => boolean) {
      const generation = ++attempt
      return () => generation === attempt && eligible()
    },
    cancel() {
      attempt++
    },
  }
}

// A failed request is not evidence that a persisted conversation has disappeared.
// Only a definite missing/archived session may fall back to the project's list.
export async function resolveStartupSession(input: {
  root: string
  directories: string[]
  remembered?: { directory: string; id: string }
  get: (target: { directory: string; id: string }) => Promise<Session | undefined>
  list: (directory: string) => Promise<Session[]>
  worktrees: () => Promise<string[]>
  current: () => boolean
}) {
  if (!input.current()) return
  const directories = [...new Map([input.root, ...input.directories].map((dir) => [pathKey(dir), dir])).values()]
  const canOpen = (directory: string) => directories.some((dir) => pathKey(dir) === pathKey(directory))
  if (input.remembered?.id && !canOpen(input.remembered.directory)) {
    const live = await input.worktrees()
    if (!input.current()) return
    // Cached metadata may be incomplete; only an authoritative answer can disqualify a saved worktree.
    directories.splice(
      0,
      directories.length,
      ...new Map([input.root, ...live].map((dir) => [pathKey(dir), dir])).values(),
    )
  }
  if (input.remembered?.id && canOpen(input.remembered.directory)) {
    const saved = await input.get(input.remembered)
    if (!input.current()) return
    if (saved?.id === input.remembered.id && saved.directory && canOpen(saved.directory) && !saved.time?.archived) {
      return saved
    }
  }
  const stores = await Promise.all(
    directories.map(async (directory) => ({ path: { directory }, session: await input.list(directory) })),
  )
  if (!input.current()) return
  return latestRootSession(stores, Date.now())
}
