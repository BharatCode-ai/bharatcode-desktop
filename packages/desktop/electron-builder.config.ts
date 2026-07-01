import { execFile } from "node:child_process"
import { access, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import {
  BRANDING,
  type Channel,
  appIdForChannel,
  normalizeChannel,
  packageNameForChannel,
  productNameForChannel,
} from "./src/main/branding"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
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

async function runMacTool(command: string, args: string[], options?: { cwd?: string }) {
  const result = await execFileAsync(command, args, { ...options, maxBuffer: execBuffer })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  return { stdout, stderr, output: `${stdout}${stderr}` }
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
    const submitResult = await runMacTool("xcrun", [
      "notarytool",
      "submit",
      zipPath,
      ...authArgs,
      "--no-wait",
      "--output-format",
      "json",
    ])
    const submission = JSON.parse((submitResult.stdout || submitResult.output).trim()) as { id?: string; status?: string }
    if (!submission.id) throw new Error(`Apple notarization did not return a submission id: ${submitResult.output}`)

    while (Date.now() - started < timeoutMs) {
      const infoResult = await runMacTool("xcrun", [
        "notarytool",
        "info",
        submission.id,
        ...authArgs,
        "--output-format",
        "json",
      ])
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

const getBase = (): Configuration => ({
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
