import type { Platform } from "@/context/platform"

type BharatCodeProviderConnectMode = "desktop_oauth" | "legacy_guidance" | "provider_auth"

export function bharatCodeProviderConnectMode(
  providerID: string,
  platform: Pick<Platform, "signInToBharatCode">,
): BharatCodeProviderConnectMode {
  if (providerID !== "bharatcode") return "provider_auth"
  if (platform.signInToBharatCode) return "desktop_oauth"
  return "legacy_guidance"
}
