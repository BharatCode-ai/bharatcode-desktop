export const supportErrorCategories = [
  "startup",
  "sidecar",
  "authentication",
  "database",
  "update",
  "network",
  "renderer",
  "other",
] as const
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
  const state = choice(
    auth.state,
    ["signed_out", "signed_in", "needs_sign_in", "connection_issue", "unknown"] as const,
    "unknown",
  )
  return {
    formatVersion: 1 as const,
    generated: timestamp(input.generated),
    version:
      typeof input.version === "string" &&
      /^\d{1,4}\.\d{1,4}\.\d{1,8}(?:-(?:beta|rc|alpha)\.\d{1,8})?$/.test(input.version)
        ? input.version
        : null,
    os: {
      platform: choice(
        input.platform,
        ["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"] as const,
        "unknown",
      ),
      // Vendor/kernel suffixes can contain private host labels. Keep only the numeric release.
      release:
        typeof input.release === "string"
          ? (/^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?=$|[-. ])/.exec(input.release)?.[0] ?? null)
          : null,
      arch: choice(
        input.arch,
        ["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "loong64"] as const,
        "unknown",
      ),
    },
    channel: choice(input.channel, ["dev", "beta", "prod"] as const, "unknown"),
    auth: {
      mode: "bharatcode_oauth" as const,
      source: "cached" as const,
      state,
      authenticated: (state === "signed_in" || state === "connection_issue") && auth.authenticated === true,
    },
    config: {
      directory: presence(config.directory),
      globalJson: presence(config.globalJson),
      globalJsonc: presence(config.globalJsonc),
      globalLegacy: presence(config.globalLegacy),
      override: presence(config.override),
      authStore: presence(config.authStore),
    },
    database: {
      source: choice(database.source, ["runtime_snapshot", "file_snapshot"] as const, "unknown"),
      capturedAt: timestamp(database.capturedAt),
      availability: choice(
        database.availability,
        ["available", "missing", "unavailable", "memory"] as const,
        "unavailable",
      ),
      schemaVersion: integer(database.schemaVersion, 2147483647),
      migrationFormat: choice(database.migrationFormat, ["current", "legacy", "unknown"] as const, "unknown"),
      appliedCount: integer(database.appliedCount, 1000000),
      latestMigration:
        typeof database.latestMigration === "number" && /^(?:20\d\d)\d{10}$/.test(String(database.latestMigration))
          ? database.latestMigration
          : null,
    },
    errors: {
      scope: "current_run" as const,
      windowHours: 24 as const,
      retainedLimit: 200 as const,
      counts: {
        startup: integer(errors.startup, 200) ?? 0,
        sidecar: integer(errors.sidecar, 200) ?? 0,
        authentication: integer(errors.authentication, 200) ?? 0,
        database: integer(errors.database, 200) ?? 0,
        update: integer(errors.update, 200) ?? 0,
        network: integer(errors.network, 200) ?? 0,
        renderer: integer(errors.renderer, 200) ?? 0,
        other: integer(errors.other, 200) ?? 0,
      },
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
function choice<T extends string, F extends string>(value: unknown, choices: readonly T[], fallback: F): T | F {
  return choices.find((item) => item === value) ?? fallback
}
function presence(value: unknown) {
  return typeof value === "boolean" ? value : ("unavailable" as const)
}
function integer(value: unknown, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function timestamp(value: unknown) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null
}
