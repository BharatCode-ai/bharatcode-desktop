import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"
import { Capabilities } from "../../src/capabilities"

async function main() {
  const parent = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(parent, "bc-capabilities-native-"))
  try {
    const data = path.join(root, "new-private-data")
    const store = Capabilities.store({ data, desktop: false })
    await store.change("github", "enable")
    assert.equal((await Capabilities.store({ data, desktop: false }).read()).installed.github.enabled, true)
    await store.change("github", "disable")
    assert.deepEqual((await store.overlay()).mcp, {})
    await store.change("github", "uninstall")
    assert.deepEqual((await store.read()).installed, {})
    await store.change("superpowers-obra", "enable")
    const overlay = await store.overlay()
    assert.ok(await fs.readFile(path.join(overlay.skills!.paths![0], "using-superpowers/SKILL.md"), "utf8"))
    process.stdout.write(JSON.stringify({ platform: process.platform, passed: 5, privateRoot: true }) + "\n")
  } finally {
    const resolved = await fs.realpath(root)
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("bc-capabilities-native-"))
      throw Error("cleanup scope mismatch")
    await fs.rm(resolved, { recursive: true, force: true })
  }
}
main().catch(() => {
  process.stderr.write("Native capabilities fixture failed\n")
  process.exitCode = 1
})
