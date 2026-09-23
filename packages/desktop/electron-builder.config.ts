import path from "node:path"
import { fileURLToPath } from "node:url"
import { Arch, type Configuration } from "electron-builder"
import { BHARATCODE_NATIVE_ENGLISH } from "../app/src/i18n/bharatcode"
import { verifyWslArtifact, wslRuntimeFilename } from "./src/main/wsl/artifact"
import {
  BRANDING,
  appIdForChannel,
  normalizeChannel,
  packageNameForChannel,
  productNameForChannel,
} from "./src/main/branding"

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const channel = normalizeChannel(process.env.BHARATCODE_CHANNEL ?? process.env.OPENCODE_CHANNEL)
const appId = appIdForChannel(channel)
const metainfo = `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

export function assertPackagingPolicy(platform: string, env = process.env, buildChannel = channel) {
  if (platform === "win32" && env.BHARATCODE_ALLOW_UNSIGNED_WINDOWS !== "1") {
    throw new Error("Windows beta packaging requires explicit unsigned-policy acknowledgement")
  }
  if (platform === "darwin" && buildChannel !== "dev") {
    if (!env.CSC_LINK && !env.CSC_NAME) throw new Error("macOS release requires Developer ID signing")
    if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
      throw new Error("macOS release requires Apple notarization credentials")
    }
  }
}

const config: Configuration = {
  appId,
  productName: productNameForChannel(channel),
  artifactName: "bharatcode-desktop-${os}-${arch}.${ext}",
  directories: { output: "dist", buildResources: "resources" },
  extraMetadata: { desktopName: `${appId}.desktop` },
  files: ["out/**/*", "resources/**/*", "!resources/bharatcode-cli*", "!resources/wsl-runtime/**/*"],
  extraResources: [
    { from: "resources/", to: "", filter: ["bharatcode-cli*"] },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  beforePack: async (context) => {
    assertPackagingPolicy(context.electronPlatformName)
    if (context.electronPlatformName !== "win32") return
    const arch = process.env.BHARATCODE_WSL_RUNTIME_ARCH
    if (arch !== "x64" && arch !== "arm64") throw new Error("Missing Windows WSL runtime architecture")
    if (context.arch !== Arch[arch]) throw new Error("Windows and WSL runtime architectures differ")
    await verifyWslArtifact({
      runtimePath: path.join(packageDir, "resources/wsl-runtime", wslRuntimeFilename(arch)),
      manifestPath: path.join(packageDir, "resources/wsl-runtime/manifest.json"),
      expectedSourceSha: process.env.BHARATCODE_SOURCE_SHA ?? "unavailable",
      expectedVersion: context.packager.appInfo.version,
      expectedArch: arch,
      expectedChannel: channel,
    })
  },
  protocols: { name: BRANDING.appName, schemes: [BRANDING.protocol] },
  ...(channel === "dev"
    ? {}
    : {
        publish: {
          provider: "github",
          owner: BRANDING.repo.owner,
          repo: BRANDING.repo.name,
          channel: channel === "beta" ? "beta" : "latest",
        },
      }),
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
    hardenedRuntime: true,
    extendInfo: { NSMicrophoneUsageDescription: BHARATCODE_NATIVE_ENGLISH["desktop.dictation.microphone"] },
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: channel !== "dev",
    target: ["dmg", "zip"],
  },
  dmg: { sign: channel !== "dev" },
  win: {
    extraResources: [{ from: "resources/wsl-runtime", to: "wsl-runtime", filter: ["*"] }],
    icon: "resources/icons/icon.ico",
    // Current Windows release policy is explicitly unsigned. Never invoke an
    // inherited upstream/Azure signer or opportunistically discover a certificate.
    signtoolOptions: { sign: async () => assertPackagingPolicy("win32") },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "resources/icons/icon.ico",
    installerHeaderIcon: "resources/icons/icon.ico",
  },
  linux: {
    icon: "resources/icons",
    category: "Development",
    executableName: packageNameForChannel(channel),
    desktop: { entry: { StartupWMClass: appId } },
    target: ["AppImage", "deb"],
  },
  deb: { fpm: [metainfo] },
}

export default config
