import { base64Encode } from "@opencode-ai/core/util/encode"

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

export function startupChatPath(directory: string) {
  return `/${base64Encode(directory)}/session`
}
