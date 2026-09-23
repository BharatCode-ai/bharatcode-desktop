import { Capabilities } from "@opencode-ai/core/capabilities"
import { Global } from "@opencode-ai/core/global"

export function migrateDesktopCapabilities(userData: string) {
  return Capabilities.migrateDesktop({ data: Global.Path.data, userData })
}
