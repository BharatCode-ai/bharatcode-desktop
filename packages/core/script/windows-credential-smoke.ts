import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "../src/util/windows-credential-store"

if (process.platform !== "win32") throw new Error("Windows smoke requires a native Windows host")
const home = await mkdtemp(path.join(os.tmpdir(), "bc-credential-smoke-"))
const store = windowsCredentialStore(path.join(home, "private", "auth.json"))
const codes = new Set(["CREDENTIAL_HELPER_TIMEOUT", "CREDENTIAL_HELPER_START_FAILED", "CREDENTIAL_HELPER_REJECTED"])
try {
  for (const [operation, run] of [
    ["prepare", () => store.prepareParent()],
    ["missing", () => assert.equal(store.read(), undefined)],
    ["publish", () => store.publish('{"fixture":"synthetic"}')],
    ["read", () => assert.equal(store.read(), '{"fixture":"synthetic"}')],
    ["logout", () => store.publish("{}")],
  ] as const) {
    const start = performance.now()
    try {
      run()
      console.log(JSON.stringify({ operation, elapsedMs: Math.round(performance.now() - start), result: "PASS" }))
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined
      const result = typeof cause === "string" && codes.has(cause) ? cause : "CREDENTIAL_SMOKE_FAILED"
      console.error(JSON.stringify({ operation, elapsedMs: Math.round(performance.now() - start), result }))
      process.exitCode = 1
      break
    }
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
