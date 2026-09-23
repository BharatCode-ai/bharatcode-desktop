import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"
import { Capabilities } from "../../src/capabilities"
import { windowsCredentialStore } from "../../src/util/windows-credential-store"

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
    const userData = path.join(root, "electron-private")
    const oldFile = path.join(userData, "bharatcode.capabilities")
    const oldStore = windowsCredentialStore(oldFile)
    oldStore.prepareParent()
    const oldText = JSON.stringify({
      "state.v1": {
        version: 1,
        installed: {
          "superpowers-obra": { id: "superpowers-obra", enabled: false },
          github: { id: "github", enabled: true },
        },
      },
    })
    oldStore.publish(oldText)
    const migratedData = path.join(root, "migrated-private")
    await Capabilities.migrateDesktop({ data: migratedData, userData })
    const migrated = Capabilities.store({ data: migratedData, desktop: true })
    assert.equal((await migrated.read()).installed["superpowers-obra"].enabled, false)
    assert.equal((await migrated.read()).installed.github.enabled, true)
    assert.equal(oldStore.read(), oldText)
    await migrated.change("github", "disable")
    await Capabilities.migrateDesktop({ data: migratedData, userData })
    assert.equal((await migrated.read()).installed.github.enabled, false)
    assert.deepEqual(
      (
        await migrated.filterLegacy({
          mcp: {
            github: {
              type: "remote",
              url: "https://api.githubcopilot.com/mcp/",
              enabled: true,
            },
          },
        })
      ).mcp,
      {},
    )
    const linked = path.join(userData, "linked")
    await fs.link(oldFile, linked)
    await assert.rejects(Capabilities.migrateDesktop({ data: path.join(root, "reject-link"), userData }), {
      message: "Capability state is unavailable. Re-read state before retrying.",
    })
    await fs.rm(linked)
    oldStore.publish("malformed synthetic source")
    await assert.rejects(Capabilities.migrateDesktop({ data: path.join(root, "reject-malformed"), userData }), {
      message: "Capability state is unavailable. Re-read state before retrying.",
    })
    assert.equal(oldStore.read(), "malformed synthetic source")
    process.stdout.write(JSON.stringify({ platform: process.platform, passed: 12, privateRoot: true }) + "\n")
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
