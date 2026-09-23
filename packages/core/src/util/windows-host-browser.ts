import { execFile } from "node:child_process"
import path from "node:path"

type BrowserEnv = Record<string, string | undefined>

export function openWindowsHostUrl(url: string, options: { env?: BrowserEnv; execFile?: typeof execFile } = {}) {
  const env = options.env ?? process.env
  const launch = options.execFile ?? execFile
  const fail = () => new Error("Could not open your Windows browser. Please retry sign-in.")
  return new Promise<void>((resolve, reject) => {
    const root = env.SystemRoot ?? env.WINDIR
    const parsed = URL.canParse(url) ? new URL(url) : undefined
    if (
      !root ||
      !path.win32.isAbsolute(root) ||
      !parsed ||
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      reject(fail())
      return
    }
    // Resolve the signed-in Windows user's known folders only in the launcher.
    // Never overwrite the app/sidecar's deliberately isolated storage environment.
    // OAuth URL bytes stay in stdin, not command text/argv or environment.
    try {
      const child = launch(
        path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsHostScript],
        {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 1024,
          encoding: "utf8",
          env: { SystemRoot: root, WINDIR: root, TEMP: env.TEMP, TMP: env.TMP },
        },
        (error, stdout) => (error || stdout !== "accepted" ? reject(fail()) : resolve()),
      )
      child.stdin?.on("error", () => {
        child.kill()
        reject(fail())
      })
      if (!child.stdin) {
        child.kill()
        reject(fail())
        return
      }
      child.stdin.end(url)
    } catch {
      reject(fail())
    }
  })
}

const windowsHostScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $url = [Console]::In.ReadToEnd()
  $uri = [Uri]$url
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('https','http') -or $uri.UserInfo) { throw 'Invalid URL' }
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  $roaming = [Environment]::GetFolderPath('ApplicationData')
  $profile = [Environment]::GetFolderPath('UserProfile')
  if (-not $local -or -not $roaming -or -not $profile) { throw 'Windows profile unavailable' }
  $env:LOCALAPPDATA = $local
  $env:APPDATA = $roaming
  $env:USERPROFILE = $profile
  $env:HOME = $profile
  $shell = New-Object -ComObject Shell.Application
  $shell.ShellExecute($url, '', '', 'open', 1)
  [Console]::Out.Write('accepted')
} catch { exit 1 }
`
