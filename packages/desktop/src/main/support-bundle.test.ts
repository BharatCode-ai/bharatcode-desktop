import { expect, test } from "bun:test"
import { createSupportBundle } from "./support-bundle"

const input = {
  generated: "2026-10-21T12:00:00.000Z",
  version: "1.15.42",
  platform: "linux",
  release: "6.17.1-300.fc43.x86_64",
  arch: "x64",
  channel: "beta",
  auth: { state: "signed_in", authenticated: true },
  config: {
    directory: true,
    globalJson: true,
    globalJsonc: false,
    globalLegacy: false,
    override: false,
    authStore: true,
  },
  database: {
    availability: "available",
    schemaVersion: 42,
    migrationFormat: "current",
    appliedCount: 30,
    latestMigration: 20260919234912,
  },
  errors: { sidecar: 2 },
}

test("constructs only versioned diagnostic fields and omits extra private data", () => {
  const result = createSupportBundle({
    ...input,
    token: "sk-private-sentinel",
    auth: { ...input.auth, email: "owner@private.test", token: "sk-private-sentinel" },
  })
  expect(Object.keys(result)).toEqual([
    "formatVersion",
    "generated",
    "version",
    "os",
    "channel",
    "auth",
    "config",
    "database",
    "errors",
  ])
  expect(result.auth).toEqual({ mode: "bharatcode_oauth", source: "cached", state: "signed_in", authenticated: true })
  expect(result.database).toEqual(input.database)
  expect(result.errors).toEqual({
    scope: "current_run",
    windowHours: 24,
    retainedLimit: 200,
    counts: { startup: 0, sidecar: 2, authentication: 0, database: 0, update: 0, network: 0, renderer: 0, other: 0 },
  })
  expect(JSON.stringify(result)).not.toContain("sk-private-sentinel")
  expect(JSON.stringify(result)).not.toContain("owner@private.test")
})

test("rejects hostile strings in every diagnostic string slot", () => {
  for (const secret of [
    "sk-private-sentinel",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature",
    "owner@private.test",
    "https://github.com/private/repo",
    "/home/private/project",
    "my private prompt",
    "1.2.3+secret-token",
    "1.2.3-private-token",
    "6.17.1-secret-token",
  ]) {
    const result = createSupportBundle({
      ...input,
      generated: secret,
      version: secret,
      release: secret,
      platform: secret,
      arch: secret,
      channel: secret,
      auth: { state: secret, authenticated: secret },
      config: { directory: secret },
      database: { availability: secret, migrationFormat: secret, latestMigration: secret },
      errors: { [secret]: 4 },
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  }
})

test("invalid or missing metadata stays unknown and numeric fields are bounded", () => {
  const result = createSupportBundle({
    database: { schemaVersion: NaN, appliedCount: Infinity, latestMigration: -1 },
    errors: { sidecar: 10000, network: -1, other: 1.5 },
  })
  expect(result.version).toBeNull()
  expect(result.generated).toBeNull()
  expect(result.auth.state).toBe("unknown")
  expect(result.auth.authenticated).toBe(false)
  expect(result.config.directory).toBe("unavailable")
  expect(result.database).toEqual({
    availability: "unavailable",
    schemaVersion: null,
    migrationFormat: "unknown",
    appliedCount: null,
    latestMigration: null,
  })
  expect(result.errors.counts.sidecar).toBe(0)
  expect(result.errors.counts.network).toBe(0)
  expect(result.errors.counts.other).toBe(0)
})

test("auth truth cannot contradict state and output never retains input references", () => {
  const result = createSupportBundle({ ...input, auth: { state: "signed_out", authenticated: true } })
  expect(result.auth.authenticated).toBe(false)
  const original = createSupportBundle(input)
  input.auth.state = "private secret"
  expect(original.auth.state).toBe("signed_in")
  input.auth.state = "signed_in"
})
