import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "../src/util/windows-credential-store"

if (process.platform !== "win32") throw new Error("Windows smoke requires a native Windows host")
const home = await mkdtemp(path.join(os.tmpdir(), "bc-credential-smoke-"))
const diagnostic = process.argv.includes("--diagnose")
const store = windowsCredentialStore(
  path.join(home, "private", "auth.json"),
  diagnostic
    ? {
        spawn: ((command, args, options) => {
          const markers = ["BC_HELPER_BOOT", "BC_HELPER_COMPILED", "BC_HELPER_INPUT", "BC_HELPER_DONE"]
          const script = args!
            .at(-1)!
            .replace(
              "  Add-Type -TypeDefinition",
              "  [Console]::Error.WriteLine('BC_HELPER_BOOT')\n  Add-Type -TypeDefinition",
            )
            .replace("  $request =", "  [Console]::Error.WriteLine('BC_HELPER_COMPILED')\n  $request =")
            .replace(
              "  if ($request.operation",
              "  [Console]::Error.WriteLine('BC_HELPER_INPUT')\n  if ($request.operation",
            )
            .replace("  [Console]::Out.Write", "  [Console]::Error.WriteLine('BC_HELPER_DONE')\n  [Console]::Out.Write")
          const start = performance.now()
          const result = spawnSync(command, [...args!.slice(0, -1), script], { ...options, timeout: 60_000 })
          // Only fixed markers from this synthetic fixture; never forward helper stderr.
          console.log(
            JSON.stringify({
              phases: markers.filter((marker) => String(result.stderr).split(/\r?\n/).includes(marker)),
              elapsedMs: Math.round(performance.now() - start),
            }),
          )
          return result
        }) as typeof spawnSync,
      }
    : {},
)
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
