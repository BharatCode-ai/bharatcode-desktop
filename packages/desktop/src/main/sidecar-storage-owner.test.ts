import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("sidecar activates shared directory owner before logging or database/server startup", () => {
  const source = readFileSync(new URL("./sidecar.ts", import.meta.url), "utf8")
  const prepare = source.indexOf("await ensureGlobalDirectories()")
  expect(prepare).toBeGreaterThan(source.indexOf('import("virtual:opencode-server")'))
  expect(prepare).toBeLessThan(source.indexOf("await Log.init"))
  expect(prepare).toBeLessThan(source.indexOf("if (command.needsMigration)"))
  expect(prepare).toBeLessThan(source.indexOf("await Server.listen"))
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  expect(main.indexOf("startupRecovery.waitUntilReady")).toBeLessThan(main.indexOf("return spawnLocalServer("))
})
