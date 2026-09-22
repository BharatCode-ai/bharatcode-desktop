import semver from "semver"

export function releaseIdentity(version: string, env: Record<string, string | undefined>) {
  const raw = env.BHARATCODE_CHANNEL ?? env.OPENCODE_CHANNEL ?? "dev"
  const channel = raw === "latest" ? "prod" : raw
  if (channel !== "dev" && channel !== "beta" && channel !== "prod") throw new Error("Invalid release channel")
  const explicit = env.BHARATCODE_VERSION ?? env.OPENCODE_VERSION
  const bump = env.OPENCODE_BUMP
  if (bump && !["major", "minor", "patch"].includes(bump)) throw new Error("Invalid release version bump")
  const resolved = explicit ?? (bump ? semver.inc(version, bump as "major" | "minor" | "patch") : version)
  if (!resolved || !semver.valid(resolved)) throw new Error("Invalid release version")
  return { channel, version: resolved, preview: channel !== "prod" }
}
