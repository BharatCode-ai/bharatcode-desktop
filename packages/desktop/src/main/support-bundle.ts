export const supportErrorCategories = ["startup", "sidecar", "authentication", "database", "update", "network", "renderer", "other"] as const
export type SupportErrorCategory = (typeof supportErrorCategories)[number]
export type SupportErrorSummary = Record<SupportErrorCategory, number>
export type SupportBundleInput = Record<string, unknown>
export type SupportBundle = ReturnType<typeof createSupportBundle>
export type SupportAuthSummary = SupportBundle["auth"]
export type SupportMetadata = Pick<SupportBundle, "config" | "database">

// This is the final privacy boundary, including for callers with stale types.
// Never spread source objects into the exported document.
export function createSupportBundle(input: SupportBundleInput) {
  const auth = record(input.auth)
  const config = record(input.config)
  const database = record(input.database)
  const errors = record(input.errors)
  const state = choice(auth.state, ["signed_out", "signed_in", "needs_sign_in", "connection_issue", "unknown"] as const, "unknown")
  return {
    formatVersion: 1 as const,
    generated: typeof input.generated === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.generated) && Number.isFinite(Date.parse(input.generated)) ? input.generated : null,
    version: typeof input.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,8}(?:-(?:beta|rc|alpha)\.\d{1,8})?$/.test(input.version) ? input.version : null,
    os: {
      platform: choice(input.platform, ["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"] as const, "unknown"),
      // Vendor/kernel suffixes can contain private host labels. Keep only the numeric release.
      release: typeof input.release === "string" ? /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?=$|[-. ])/.exec(input.release)?.[0] ?? null : null,
      arch: choice(input.arch, ["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "loong64"] as const, "unknown"),
    },
    channel: choice(input.channel, ["dev", "beta", "prod"] as const, "unknown"),
    auth: { mode: "bharatcode_oauth" as const, source: "cached" as const, state, authenticated: state === "signed_in" && auth.authenticated === true },
    config: {
      directory: presence(config.directory), globalJson: presence(config.globalJson), globalJsonc: presence(config.globalJsonc), globalLegacy: presence(config.globalLegacy), override: presence(config.override), authStore: presence(config.authStore),
    },
    database: {
      availability: choice(database.availability, ["available", "missing", "unavailable", "memory"] as const, "unavailable"),
      schemaVersion: integer(database.schemaVersion, 2147483647),
      migrationFormat: choice(database.migrationFormat, ["current", "legacy", "unknown"] as const, "unknown"),
      appliedCount: integer(database.appliedCount, 1000000),
      latestMigration: typeof database.latestMigration === "number" && /^(?:20\d\d)\d{10}$/.test(String(database.latestMigration)) ? database.latestMigration : null,
    },
    errors: {
      scope: "current_run" as const, windowHours: 24 as const, retainedLimit: 200 as const,
      counts: Object.fromEntries(supportErrorCategories.map((category) => [category, integer(errors[category], 200) ?? 0])) as SupportErrorSummary,
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}
function choice<T extends string, F extends string>(value: unknown, choices: readonly T[], fallback: F): T | F {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback
}
function presence(value: unknown) {
  return typeof value === "boolean" ? value : "unavailable" as const
}
function integer(value: unknown, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null
}
