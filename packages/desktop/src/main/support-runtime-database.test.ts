import { expect, test } from "bun:test"
import { createRuntimeDatabaseMetadata } from "./support-runtime-database"

const snapshot = {
  availability: "available",
  source: "runtime_snapshot",
  capturedAt: "2026-10-21T12:00:00.000Z",
  schemaVersion: 42,
  migrationFormat: "current",
  appliedCount: 5,
  latestMigration: 20261021000000,
}

test("runtime metadata is projected, copied, and cleared with its exact sidecar owner", () => {
  const runtime = createRuntimeDatabaseMetadata()
  expect(runtime.read()).toBeUndefined()
  const old = runtime.attach()
  old.publish({ ...snapshot, token: "sk-private", email: "owner@private.test", rows: ["private prompt"] })
  expect(runtime.read()).toEqual(snapshot)
  const copy = runtime.read()!
  copy.schemaVersion = 99
  expect(runtime.read()!.schemaVersion).toBe(42)
  const current = runtime.attach()
  expect(runtime.read()).toBeUndefined()
  old.publish(snapshot)
  old.dispose()
  expect(runtime.read()).toBeUndefined()
  current.publish(snapshot)
  old.dispose()
  expect(runtime.read()).toEqual(snapshot)
  current.dispose()
  expect(runtime.read()).toBeUndefined()
})

test("malformed or unavailable startup metadata does not masquerade as a runtime snapshot", () => {
  const runtime = createRuntimeDatabaseMetadata()
  const owner = runtime.attach()
  for (const value of [
    null,
    {},
    { ...snapshot, source: "file_snapshot" },
    { ...snapshot, capturedAt: "private@email.test" },
    { ...snapshot, schemaVersion: "sk-secret" },
    { ...snapshot, availability: "unavailable" },
  ]) {
    owner.publish(value)
    expect(runtime.read()).toBeUndefined()
  }
})
