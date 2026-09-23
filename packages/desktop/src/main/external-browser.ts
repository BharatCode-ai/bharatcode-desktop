import { execFile as defaultExecFile } from "node:child_process"
import { openWindowsHostUrl } from "@opencode-ai/core/util/windows-host-browser"
export { openWindowsHostUrl } from "@opencode-ai/core/util/windows-host-browser"

type ExecFileCallback = (error: Error | null) => void
type ExecFile = (file: string, args: string[], callback: ExecFileCallback) => void

type BrowserEnv = Record<string, string | undefined>

export function shouldUseWindowsHostBrowser({
  platform = process.platform,
  env = process.env,
}: {
  platform?: string
  env?: BrowserEnv
} = {}) {
  return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
}

function runExplorer(url: string, execFile: ExecFile) {
  return new Promise<void>((resolve, reject) => {
    execFile("explorer.exe", [url], (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export async function openExternalUrl(
  url: string,
  {
    openExternal,
    execFile = (file, args, callback) => defaultExecFile(file, args, (error) => callback(error)),
    platform = process.platform,
    env = process.env,
    openWindowsHost = (target) => openWindowsHostUrl(target, { env }),
  }: {
    openExternal: (url: string) => Promise<void> | void
    execFile?: ExecFile
    platform?: string
    env?: BrowserEnv
    openWindowsHost?: (url: string) => Promise<void>
  },
) {
  if (platform === "win32") {
    await openWindowsHost(url)
    return
  }
  if (shouldUseWindowsHostBrowser({ platform, env })) {
    await runExplorer(url, execFile)
    return
  }

  await openExternal(url)
}
