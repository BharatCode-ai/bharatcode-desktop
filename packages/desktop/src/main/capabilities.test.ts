import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CAPABILITY_CATALOG,
  applyCapabilityRuntimeToConfig,
  createDefaultCapabilityState,
  installCapability,
  resolveCapabilityRuntime,
  setCapabilityEnabled,
  uninstallCapability,
} from "./capabilities"

describe("BharatCode capability layer", () => {
  test("bundles Superpowers enabled by default", () => {
    const state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })

    expect(state.installed["superpowers-obra"]?.status).toBe("enabled")
    expect(state.installed["superpowers-obra"]?.trust).toBe("bundled")
  })

  test("does not ship redundant native capabilities as marketplace entries", () => {
    const ids = CAPABILITY_CATALOG.map((item) => item.id)

    expect(ids).not.toContain("filesystem")
    expect(ids).not.toContain("shell")
    expect(ids).not.toContain("local-git")
    expect(ids).not.toContain("generic-fetch")
  })

  test("installs and enables a curated capability transactionally", () => {
    let state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })

    state = installCapability(state, "github", { now: "2026-05-31T01:00:00.000Z" })
    expect(state.installed.github?.status).toBe("installed")
    expect(state.installed.github?.enabled).toBe(false)

    state = setCapabilityEnabled(state, "github", true, { now: "2026-05-31T01:01:00.000Z" })
    expect(state.installed.github?.status).toBe("needs_setup")
    expect(state.installed.github?.enabled).toBe(true)
  })

  test("resolves enabled modules into a runtime manifest", () => {
    const state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })

    const runtime = resolveCapabilityRuntime(state, { superpowersSkillsPath: "/tmp/superpowers/skills" })

    expect(runtime.skills.paths).toContain("/tmp/superpowers/skills")
    expect(runtime.mcp).toEqual({})
  })

  test("removes disabled Superpowers from runtime", () => {
    const state = setCapabilityEnabled(
      createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" }),
      "superpowers-obra",
      false,
      { now: "2026-05-31T00:05:00.000Z" },
    )

    const runtime = resolveCapabilityRuntime(state, { superpowersSkillsPath: "/tmp/superpowers/skills" })

    expect(runtime.skills.paths).not.toContain("/tmp/superpowers/skills")
  })

  test("uninstall removes curated capabilities but keeps bundled Superpowers installed", () => {
    let state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })

    state = installCapability(state, "github", { now: "2026-05-31T01:00:00.000Z" })
    state = uninstallCapability(state, "github")
    expect(state.installed.github).toBeUndefined()

    state = uninstallCapability(state, "superpowers-obra")
    expect(state.installed["superpowers-obra"]?.status).toBe("installed")
    expect(state.installed["superpowers-obra"]?.enabled).toBe(false)
  })

  test("patches runtime config while preserving user-owned MCP entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bharatcode-capabilities-"))
    const configPath = join(dir, "opencode.jsonc")
    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            plugin: ["bharatcode"],
            skills: { paths: ["/user/skills", "/tmp/superpowers/skills"] },
            mcp: {
              custom: { type: "local", command: ["custom-mcp"] },
              github: { type: "remote", url: "https://old.example/mcp", enabled: true },
            },
          },
          null,
          2,
        ),
      )

      await applyCapabilityRuntimeToConfig({
        configPath,
        managedSkillPaths: ["/tmp/superpowers/skills"],
        runtime: {
          skills: { paths: [] },
          mcp: {
            "cloudflare-docs": {
              type: "remote",
              url: "https://docs.mcp.cloudflare.com/mcp",
              oauth: false,
              enabled: true,
            },
          },
        },
      })

      const config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.plugin).toEqual(["bharatcode"])
      expect(config.skills.paths).toEqual(["/user/skills"])
      expect(config.mcp.custom).toEqual({ type: "local", command: ["custom-mcp"] })
      expect(config.mcp.github).toBeUndefined()
      expect(config.mcp["cloudflare-docs"]).toEqual({
        type: "remote",
        url: "https://docs.mcp.cloudflare.com/mcp",
        oauth: false,
        enabled: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removes stale managed Superpowers bundle paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bharatcode-capabilities-"))
    const configPath = join(dir, "opencode.jsonc")
    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            skills: {
              paths: [
                "/user/skills",
                "/home/ubuntu/resources/capabilities/superpowers/skills",
                "/home/ubuntu/bharatcode/apps/desktop/packages/desktop/resources/capabilities/superpowers/skills",
              ],
            },
          },
          null,
          2,
        ),
      )

      await applyCapabilityRuntimeToConfig({
        configPath,
        runtime: {
          skills: {
            paths: [
              "/home/ubuntu/bharatcode/apps/desktop/packages/desktop/resources/capabilities/superpowers/skills",
            ],
          },
          mcp: {},
        },
      })

      const config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.skills.paths).toEqual([
        "/user/skills",
        "/home/ubuntu/bharatcode/apps/desktop/packages/desktop/resources/capabilities/superpowers/skills",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
