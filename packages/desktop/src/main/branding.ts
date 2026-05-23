export type Channel = "dev" | "beta" | "prod"

export const BRANDING = {
  appName: "BharatCode",
  protocol: "bharatcode",
  homepage: "https://bharatcode.ai",
  bugtracker: "https://github.com/BharatCode-ai/opencode/issues",
  repo: {
    owner: "BharatCode-ai",
    name: "opencode",
    url: "https://github.com/BharatCode-ai/opencode",
  },
}

export function normalizeChannel(raw: string | undefined): Channel {
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export function productNameForChannel(channel: Channel) {
  if (channel === "prod") return BRANDING.appName
  return `${BRANDING.appName} ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
}

export function appIdForChannel(channel: Channel) {
  if (channel === "prod") return "ai.bharatcode.desktop"
  return `ai.bharatcode.desktop.${channel}`
}

export function packageNameForChannel(channel: Channel) {
  if (channel === "prod") return "bharatcode"
  return `bharatcode-${channel}`
}
