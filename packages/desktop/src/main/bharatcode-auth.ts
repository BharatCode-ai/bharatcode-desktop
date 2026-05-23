import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const BHARATCODE_OAUTH = {
  issuer: "https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1",
  nativeClientId: "4cad332a-232f-4ef2-9363-12fea4420635",
  desktopRedirectUri: "bharatcode://auth/callback",
  loopbackRedirectUri: "http://127.0.0.1:27182/callback",
  vscodeRedirectUri: "vscode://bharatcode.bharatcode/auth/callback",
  modelProxy: "https://bharatcode.ai/api/model/v1",
  scope: "openid email profile",
}

export type BharatCodeAuthState = {
  authenticated: boolean
  configured: boolean
  credentialsPath: string
  configPath: string
}

type CommandSpec = { command: string; args: string[] }
type ExecFileImpl = typeof execFile

export function buildBharatCodeSignInUrl({
  state,
  codeChallenge,
  redirectUri = BHARATCODE_OAUTH.desktopRedirectUri,
}: {
  state: string
  codeChallenge: string
  redirectUri?: string
}) {
  const url = new URL(`${BHARATCODE_OAUTH.issuer}/oauth/authorize`)
  url.searchParams.set("client_id", BHARATCODE_OAUTH.nativeClientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", BHARATCODE_OAUTH.scope)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url
}

export function isBharatCodeAuthCallback(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === "bharatcode:" && url.hostname === "auth" && url.pathname === "/callback"
  } catch {
    return false
  }
}

export function buildBharatCodeCliCommands(): CommandSpec[] {
  return [
    { command: "bharatcode", args: ["auth", "login"] },
    { command: "bharatcode", args: ["opencode", "configure"] },
  ]
}

export function bharatCodeCredentialsPath(home = process.env.BHARATCODE_HOME || homedir()) {
  return join(home, ".bharatcode", "credentials.json")
}

export function opencodeConfigPath(home = process.env.BHARATCODE_HOME || homedir()) {
  return join(home, ".config", "opencode", "opencode.jsonc")
}

export async function getBharatCodeAuthState(
  home = process.env.BHARATCODE_HOME || homedir(),
): Promise<BharatCodeAuthState> {
  const credentialsPath = bharatCodeCredentialsPath(home)
  const configPath = opencodeConfigPath(home)
  return {
    authenticated: await exists(credentialsPath),
    configured: await hasBharatCodePlugin(configPath),
    credentialsPath,
    configPath,
  }
}

export async function signInToBharatCode(execFileImpl: ExecFileImpl = execFile) {
  for (const item of buildBharatCodeCliCommands()) {
    await runCommand(execFileImpl, item)
  }
  return getBharatCodeAuthState()
}

function runCommand(execFileImpl: ExecFileImpl, item: CommandSpec) {
  return new Promise<void>((resolve, reject) => {
    execFileImpl(item.command, item.args, { windowsHide: true }, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function hasBharatCodePlugin(path: string) {
  try {
    return /["']bharatcode["']/.test(await readFile(path, "utf8"))
  } catch {
    return false
  }
}
