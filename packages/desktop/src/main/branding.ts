import { join } from "node:path"
import type { App } from "electron"
import { StoragePaths } from "../../../core/src/storage-paths"

export type Channel = "dev" | "beta" | "prod"

export const BRANDING = {
  appName: "BharatCode",
  protocol: "bharatcode",
  homepage: "https://bharatcode.ai",
  bugtracker: "https://github.com/BharatCode-ai/bharatcode-desktop/issues",
  repo: {
    owner: "BharatCode-ai",
    name: "bharatcode-desktop",
    url: "https://github.com/BharatCode-ai/bharatcode-desktop",
  },
}

export function normalizeChannel(raw: string | undefined): Channel {
  if (raw === "latest") return "prod"
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export function productNameForChannel(channel: Channel) {
  if (channel === "prod") return BRANDING.appName
  return `${BRANDING.appName} ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
}

export function appIdForChannel(channel: Channel) {
  return `ai.bharatcode.desktop.${StoragePaths.desktopProfileChannel(channel)}`
}

export function packageNameForChannel(channel: Channel) {
  return `bharatcode-${StoragePaths.desktopProfileChannel(channel)}`
}

export function installedNameForChannel(channel: Channel) {
  return StoragePaths.displayName(StoragePaths.desktopProfileChannel(channel))
}

export function configureDesktopProfile(
  app: Pick<App, "getPath" | "setPath" | "setName" | "setAppUserModelId" | "setAboutPanelOptions">,
  channel: Channel,
  diagnosticDirectory?: string,
) {
  const id = appIdForChannel(channel)
  // Electron uses its internal name in macOS Keychain and Linux secret stores.
  // The installer's productName is the user-facing brand, not a credential key.
  app.setName(installedNameForChannel(channel))
  app.setAppUserModelId(id)
  app.setPath("userData", diagnosticDirectory ?? join(app.getPath("appData"), id))
  app.setAboutPanelOptions({ applicationName: productNameForChannel(channel) })
}

export function shouldRegisterProtocol(input: { packaged: boolean; channel: Channel; diagnostic: boolean }) {
  return input.packaged && input.channel !== "dev" && !input.diagnostic
}
