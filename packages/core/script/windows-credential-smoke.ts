import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "../src/util/windows-credential-store"

if (process.platform !== "win32") throw new Error("Windows smoke requires a native Windows host")
const home = await mkdtemp(path.join(os.tmpdir(), "bc-credential-smoke-"))
const store = windowsCredentialStore(
  path.join(home, "private", "auth.json"),
  process.argv.includes("--diagnose")
    ? {
        spawn: ((command, args, options) => {
          const marker = (name: string) =>
            `  [Console]::Error.WriteLine('BC_PHASE_${name}:' + $clock.ElapsedMilliseconds)`
          const script = args!
            .at(-1)!
            .replace("try {", "try {\n  $clock = [Diagnostics.Stopwatch]::StartNew()\n" + marker("BOOT"))
            .replace("  $request =", marker("COMPILED") + "\n  $request =")
            .replace("  if ($request.operation", marker("INPUT") + "\n  if ($request.operation")
            .replace("  [Console]::Out.Write", marker("DONE") + "\n  [Console]::Out.Write")
          const start = performance.now()
          const result = spawnSync(command, [...args!.slice(0, -1), script], { ...options, timeout: 90_000 })
          // Diagnostic-only synthetic fixture: never forward raw stderr, paths or content.
          const phases = String(result.stderr)
            .split(/\r?\n/)
            .flatMap((line) => {
              const match = /^BC_PHASE_(BOOT|COMPILED|INPUT|DONE):([0-9]{1,8})$/.exec(line)
              return match ? [{ phase: match[1], elapsedMs: Number(match[2]) }] : []
            })
          console.log(
            JSON.stringify({
              runtime: process.versions.bun ? "bun" : "node",
              phases,
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
