import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Arch, type Configuration } from "electron-builder"
import {
  BRANDING,
  type Channel,
  appIdForChannel,
  normalizeChannel,
  packageNameForChannel,
  productNameForChannel,
} from "./src/main/branding"
import { verifyWslArtifact, wslRuntimeFilename, type WslRuntimeArch } from "./src/main/wsl-artifact"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const desktopDir = path.dirname(fileURLToPath(import.meta.url))
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const execBuffer = 10 * 1024 * 1024

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

type MacAfterSignContext = {
  appOutDir: string
  electronPlatformName?: string
  packager?: {
    appInfo?: {
      productFilename?: string
    }
  }
}

async function pathExists(target: string) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required macOS notarization environment variable: ${name}`)
  return value
}

async function runMacTool(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    maxBuffer: execBuffer,
    timeout: options?.timeoutMs,
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  return { stdout, stderr, output: `${stdout}${stderr}` }
}

export function isTransientNotaryStatusError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "killed" in error &&
    "signal" in error &&
    (error as { killed?: unknown }).killed === true &&
    (error as { signal?: unknown }).signal === "SIGTERM"
  ) {
    return true
  }

  const message = error instanceof Error ? error.message : String(error)
  return [
    "NSURLErrorDomain Code=-1009",
    "The Internet connection appears to be offline",
    "No network route",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "network connection was lost",
    "timed out",
  ].some((pattern) => message.toLowerCase().includes(pattern.toLowerCase()))
}

function notaryAuthArgs() {
  return [
    "--key",
    requiredEnv("APPLE_API_KEY"),
    "--key-id",
    requiredEnv("APPLE_API_KEY_ID"),
    "--issuer",
    requiredEnv("APPLE_API_ISSUER"),
  ]
}

async function findMacApp(context: MacAfterSignContext) {
  const productFilename = context.packager?.appInfo?.productFilename
  if (productFilename) {
    const appPath = path.join(context.appOutDir, `${productFilename}.app`)
    if (await pathExists(appPath)) return appPath
  }

  const entries = await readdir(context.appOutDir, { withFileTypes: true })
  const app = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
  if (!app) throw new Error(`No .app bundle found in ${context.appOutDir}`)
  return path.join(context.appOutDir, app.name)
}

async function notarizeMac(context: MacAfterSignContext) {
  if (process.platform !== "darwin") return
  if (context.electronPlatformName && context.electronPlatformName !== "darwin") return
  if (allowUnsignedMac) return

  const appPath = await findMacApp(context)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bharatcode-notary-"))
  const zipPath = path.join(tempDir, `${path.basename(appPath, ".app")}.zip`)
  const timeoutMinutes = Number.parseInt(process.env.BHARATCODE_NOTARY_TIMEOUT_MINUTES || "45", 10)
  const timeoutMs = Math.max(Number.isFinite(timeoutMinutes) ? timeoutMinutes : 45, 5) * 60 * 1000
  const submitTimeoutMinutes = Number.parseInt(process.env.BHARATCODE_NOTARY_SUBMIT_TIMEOUT_MINUTES || "10", 10)
  const submitTimeoutMs = Math.max(Number.isFinite(submitTimeoutMinutes) ? submitTimeoutMinutes : 10, 1) * 60 * 1000
  const statusTimeoutSeconds = Number.parseInt(process.env.BHARATCODE_NOTARY_STATUS_TIMEOUT_SECONDS || "90", 10)
  const statusTimeoutMs = Math.max(Number.isFinite(statusTimeoutSeconds) ? statusTimeoutSeconds : 90, 15) * 1000
  const started = Date.now()
  const authArgs = notaryAuthArgs()

  try {
    console.log(`Preparing ${path.basename(appPath)} for Apple notarization`)
    await runMacTool(
      "ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zipPath],
      { cwd: path.dirname(appPath) },
    )

    console.log("Submitting BharatCode macOS app to Apple notarization service")
    const submitResult = await runMacTool(
      "xcrun",
      ["notarytool", "submit", zipPath, ...authArgs, "--no-wait", "--output-format", "json"],
      { timeoutMs: submitTimeoutMs },
    )
    const submission = JSON.parse((submitResult.stdout || submitResult.output).trim()) as { id?: string; status?: string }
    if (!submission.id) throw new Error(`Apple notarization did not return a submission id: ${submitResult.output}`)

    while (Date.now() - started < timeoutMs) {
      const infoResult = await runMacTool(
        "xcrun",
        ["notarytool", "info", submission.id, ...authArgs, "--output-format", "json"],
        { timeoutMs: statusTimeoutMs },
      ).catch(async (error) => {
        if (!isTransientNotaryStatusError(error)) throw error
        console.warn(`Apple notarization ${submission.id}: transient status check failed; retrying until timeout`)
        await new Promise((resolve) => setTimeout(resolve, 30_000))
        return undefined
      })
      if (!infoResult) continue
      const info = JSON.parse((infoResult.stdout || infoResult.output).trim()) as { status?: string }
      console.log(`Apple notarization ${submission.id}: ${info.status ?? "unknown"}`)

      if (info.status === "Accepted") {
        await runMacTool("xcrun", ["stapler", "staple", appPath])
        await runMacTool("xcrun", ["stapler", "validate", appPath])
        console.log(`Apple notarization accepted and stapled for ${path.basename(appPath)}`)
        return
      }

      if (info.status === "Invalid" || info.status === "Rejected") {
        const logResult = await runMacTool("xcrun", [
          "notarytool",
          "log",
          submission.id,
          ...authArgs,
          "--output-format",
          "json",
        ])
        throw new Error(`Apple notarization ${info.status.toLowerCase()} submission ${submission.id}:\n${logResult.output}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 30_000))
    }

    throw new Error(`Apple notarization timed out after ${Math.round(timeoutMs / 60_000)} minutes`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

const channel = (() => {
  return normalizeChannel(process.env.BHARATCODE_CHANNEL || process.env.OPENCODE_CHANNEL)
})()

function updateChannelForChannel(channel: Channel) {
  return channel === "beta" ? "beta" : "latest"
}

const allowUnsignedMac = process.env.BHARATCODE_ALLOW_UNSIGNED_MAC === "1"

function requiredWslBuildEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required WSL runtime build environment variable: ${name}`)
  return value
}

const verifyWslBeforePack: NonNullable<Configuration["beforePack"]> = async (context) => {
  if (context.electronPlatformName !== "win32") return
  const arch: WslRuntimeArch = (() => {
    if (context.arch === Arch.x64) return "x64"
    if (context.arch === Arch.arm64) return "arm64"
    throw new Error("Windows WSL runtime packaging supports only x64 or arm64")
  })()
  const packageJson = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8")) as { version?: unknown }
  if (typeof packageJson.version !== "string") throw new Error("Desktop package version is missing")
  const resourceDir = path.join(desktopDir, "resources", "wsl-runtime")
  await verifyWslArtifact({
    runtimePath: path.join(resourceDir, wslRuntimeFilename(arch)),
    manifestPath: path.join(resourceDir, "manifest.json"),
    expectedSourceSha: requiredWslBuildEnv("INTEGRATED_HEAD"),
    expectedVersion: packageJson.version,
    expectedArch: arch,
  })
}

const getBase = (): Configuration => ({
  beforePack: verifyWslBeforePack,
  afterSign: process.platform === "darwin" && !allowUnsignedMac ? notarizeMac : undefined,
  artifactName: "bharatcode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      from: "resources/provider",
      to: "provider",
      filter: ["**/*"],
    },
    {
      from: "resources/capabilities",
      to: "capabilities",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: !allowUnsignedMac,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    identity: allowUnsignedMac ? null : undefined,
    notarize: false,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: !allowUnsignedMac,
  },
  protocols: {
    name: BRANDING.appName,
    schemes: [BRANDING.protocol],
  },
  win: {
    extraResources: [
      {
        from: "resources/wsl-runtime",
        to: "wsl-runtime",
        filter: ["manifest.json", "bharatcode-runtime-linux-x64-glibc", "bharatcode-runtime-linux-arm64-glibc"],
      },
    ],
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    executableName: packageNameForChannel(channel),
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: appIdForChannel(channel),
        productName: productNameForChannel(channel),
        rpm: { packageName: packageNameForChannel(channel) },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: appIdForChannel(channel),
        productName: productNameForChannel(channel),
        protocols: { name: productNameForChannel(channel), schemes: [BRANDING.protocol] },
        publish: {
          provider: "github",
          owner: BRANDING.repo.owner,
          repo: BRANDING.repo.name,
          channel: updateChannelForChannel(channel),
        },
        rpm: { packageName: packageNameForChannel(channel) },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: appIdForChannel(channel),
        productName: productNameForChannel(channel),
        protocols: { name: productNameForChannel(channel), schemes: [BRANDING.protocol] },
        publish: {
          provider: "github",
          owner: BRANDING.repo.owner,
          repo: BRANDING.repo.name,
          channel: updateChannelForChannel(channel),
        },
        rpm: { packageName: packageNameForChannel(channel) },
      }
    }
  }
}

export default getConfig()
