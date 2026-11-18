import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowseSetup } from "./browse"

test("Browse setup rejects unknown actions and missing bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-browse-absent-"))
  try {
    const setup = createBrowseSetup(
      () => root,
      () => root,
    )
    expect(await setup("unknown")).toEqual({ state: "failed" })
    expect(await setup("upgrade")).toEqual({ state: "failed" })
    expect(await setup("setup")).toEqual({ state: "unavailable" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Exercise the production filesystem/process integration with a disposable relay peer,
// never the user's running relay. Native Windows/macOS packaging remains a separate gate.
test.skipIf(process.platform === "win32")("only explicit setup installs and restarts a same-pin rebuild", async () => {
  const fixture = await browseFixture(false)
  try {
    expect(await stat(fixture.binary).catch(() => undefined)).toBeUndefined()
    expect((await fixture.state()).restarts).toBe(0)
    expect(await fixture.setup("check")).toEqual({ state: "waiting" })
    expect(await stat(fixture.binary).catch(() => undefined)).toBeUndefined()
    expect(await fixture.setup("setup")).toMatchObject({ state: "connected", command: [fixture.binary, "mcp"] })
    expect((await fixture.state()).restarts).toBe(1)
    expect(await readFile(fixture.pairing, "utf8")).toBe("fixture-pairing")
    expect(await fixture.setup("check")).toMatchObject({ state: "connected" })
    expect((await fixture.state()).restarts).toBe(1)
  } finally {
    await fixture.close()
  }
})

test.skipIf(process.platform === "win32")(
  "explicit setup cannot force a restart during active browser work",
  async () => {
    const fixture = await browseFixture(true)
    try {
      expect(await fixture.setup("setup")).toEqual({ state: "failed" })
      expect(await readFile(fixture.pairing, "utf8")).toBe("fixture-pairing")
      expect(await fixture.state()).toMatchObject({ build: "old", restarts: 1, force: false })
    } finally {
      await fixture.close()
    }
  },
)

test("Desktop startup has no Browse migration or background configuration writer", async () => {
  const entry = await Bun.file(new URL("./index.ts", import.meta.url)).text()
  const runtime = await Bun.file(new URL("./browse.ts", import.meta.url)).text()
  expect(entry).not.toContain('from "./browse"')
  expect(entry).not.toContain("upgradeBundledBrowse")
  expect(runtime).not.toContain("/global/config")
})

test("candidate gives every rebuild a fresh shared Browse identity and requires an explicit store ID", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../../.github/workflows/publish.yml", import.meta.url)).text(),
  ) as {
    jobs: { package: { steps: { name?: string; env?: Record<string, string>; run?: string }[] } }
  }
  const step = workflow.jobs.package.steps.find((step) => step.name === "Build and stage bundled Browse")
  expect(step?.env?.OPENCODE_BROWSER_STORE_ID).toBe("${{ vars.BROWSE_CHROME_STORE_ID }}")
  expect(step?.run).toContain('[[ ! "$OPENCODE_BROWSER_STORE_ID" =~ ^[a-p]{32}$ ]]')
  expect(step?.run).toContain("export OPENCODE_BROWSER_BUILD=\"$(node -p 'new Date().toISOString()')\"")
  expect(step?.run).not.toContain("git show -s --format=%cI")
  expect(await Bun.file(new URL("../../browse-source.sha", import.meta.url)).text()).toBe(
    "3e8f2915ab382c2afa5f15fbaf5ca7f35a3c8d0c\n",
  )
})

async function browseFixture(active: boolean) {
  const root = await mkdtemp(join(tmpdir(), "bc-browse-setup-"))
  const resources = join(root, "resources")
  const userData = join(root, "user-data")
  const bundle = join(resources, "bharatcode-browse")
  const home = join(userData, "browse", "relay")
  const binary = join(userData, "browse", "b".repeat(64), "browse")
  const pairing = join(home, "browser-tokens.json")
  await mkdir(bundle, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(bundle, "bundle-id"), "b".repeat(64))
  await writeFile(pairing, "fixture-pairing")
  await writeFile(join(home, "fixture.json"), JSON.stringify({ active, build: "old", restarts: 0, force: false }))
  const peer = join(root, "peer.ts")
  await writeFile(
    peer,
    `
    const file = Bun.file(process.env.OPENCODE_BROWSER_HOME + "/fixture.json")
    const state = await file.json()
    const args = process.argv.slice(2)
    if (args[0] === "status") console.log(JSON.stringify({relay: {running: true, stale: state.build !== "new"}, extension: {connected: true}}))
    else if (args.join(" ").startsWith("relay restart")) {
      state.restarts++
      state.force = args.includes("--force")
      if (!state.active) state.build = "new"
      await Bun.write(file, JSON.stringify(state))
      if (state.active) process.exit(1)
    } else process.exit(2)
  `,
  )
  await writeFile(join(bundle, "browse"), `#!/bin/sh\nexec '${process.execPath}' '${peer}' "$@"\n`)
  await chmod(join(bundle, "browse"), 0o700)
  return {
    binary,
    pairing,
    setup: createBrowseSetup(
      () => resources,
      () => userData,
    ),
    state: () => Bun.file(join(home, "fixture.json")).json(),
    close: () => rm(root, { recursive: true, force: true }),
  }
}
