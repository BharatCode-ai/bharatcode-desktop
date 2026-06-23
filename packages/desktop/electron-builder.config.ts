import { execFile } from "node:child_process"
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

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  return normalizeChannel(process.env.BHARATCODE_CHANNEL || process.env.OPENCODE_CHANNEL)
})()

function updateChannelForChannel(channel: Channel) {
  return channel === "beta" ? "beta" : "latest"
}

const allowUnsignedMac = process.env.BHARATCODE_ALLOW_UNSIGNED_MAC === "1"

const getBase = (): Configuration => ({
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
    notarize: !allowUnsignedMac,
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
