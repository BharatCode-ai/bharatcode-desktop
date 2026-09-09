import { describe, expect, test } from "bun:test"
import { chmod, mkdir, rm, symlink } from "node:fs/promises"
import path from "node:path"

import { discoverMigrationSources } from "@/migration/source"
import { tmpdir } from "../fixture/fixture"

describe("migration source discovery", () => {
  test.each([
    ["linux" as const, [".local/share/opencode", ".bharatcode"]],
    ["darwin" as const, ["Library/Application Support/ai.opencode.desktop", ".bharatcode"]],
    ["win32" as const, ["AppData/Roaming/ai.opencode.desktop", ".bharatcode"]],
  ])("discovers deterministic opaque %s choices without selecting one", async (platform, roots) => {
    await using tmp = await tmpdir()
    for (const root of roots) await mkdir(path.join(tmp.path, root), { recursive: true })
    const result = await discoverMigrationSources({
      platform,
      home: tmp.path,
      env: {},
      destinationRoots: [path.join(tmp.path, "destination")],
    })

    expect(result.map((item) => item.id)).toEqual(result.map((item) => item.id).toSorted())
    expect(result).toHaveLength(2)
    expect(result.every((item) => !item.label.includes(tmp.path))).toBe(true)
    expect(result.every((item) => /^Existing BharatCode data · [a-z-]+ · [0-9a-f]{8}$/.test(item.label))).toBe(true)
    expect(result.every((item) => !("selected" in item))).toBe(true)
  })

  test("uses only closed environment roots and keeps WSL/Linux identity stable", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "xdg-data")
    const config = path.join(tmp.path, "xdg-config")
    await mkdir(path.join(data, "opencode"), { recursive: true })
    await mkdir(path.join(config, "opencode"), { recursive: true })
    const input = {
      platform: "linux" as const,
      home: tmp.path,
      env: { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, OPENCODE_CONFIG: "/hostile" },
      destinationRoots: [path.join(tmp.path, "bharatcode")],
    }

    const first = await discoverMigrationSources(input)
    const second = await discoverMigrationSources(input)
    expect(first).toEqual(second)
    expect(first).toHaveLength(1)
    expect(first[0]?.kind).toBe("opencode-cli")
    expect(first[0]?.roots).toEqual({ data: path.join(data, "opencode"), config: path.join(config, "opencode") })
  })

  test("does not interpret Windows directory modes as POSIX execute bits", async () => {
    await using tmp = await tmpdir()
    const legacyDesktop = path.join(tmp.path, ".bharatcode")
    await mkdir(legacyDesktop)
    await chmod(legacyDesktop, 0o600)
    try {
      const result = await discoverMigrationSources({
        platform: "win32",
        home: tmp.path,
        env: {},
        destinationRoots: [path.join(tmp.path, "destination")],
      })
      expect(result.map((source) => source.kind)).toContain("bharatcode-desktop")
    } finally {
      await chmod(legacyDesktop, 0o700)
    }
  })

  test("fails closed for relative, linked, overlapping, duplicate, and unreadable roots", async () => {
    await using tmp = await tmpdir()
    await expect(
      discoverMigrationSources({
        platform: "linux",
        home: "relative-home",
        env: {},
        destinationRoots: [path.join(tmp.path, "destination")],
      }),
    ).rejects.toThrow("absolute")

    const linkedTarget = path.join(tmp.path, "linked-target")
    await mkdir(linkedTarget)
    await symlink(linkedTarget, path.join(tmp.path, ".bharatcode"))
    await expect(
      discoverMigrationSources({
        platform: "linux",
        home: tmp.path,
        env: {},
        destinationRoots: [path.join(tmp.path, "destination")],
      }),
    ).rejects.toThrow("link")

    await rm(path.join(tmp.path, ".bharatcode"))
    const current = path.join(tmp.path, ".local", "share", "bharatcode")
    await mkdir(current, { recursive: true })
    await expect(
      discoverMigrationSources({
        platform: "linux",
        home: tmp.path,
        env: {},
        destinationRoots: [current],
      }),
    ).rejects.toThrow("overlaps")

    await rm(current, { recursive: true })
    const duplicate = path.join(tmp.path, "duplicate")
    await mkdir(path.join(duplicate, "opencode"), { recursive: true })
    await expect(
      discoverMigrationSources({
        platform: "linux",
        home: tmp.path,
        env: { XDG_DATA_HOME: duplicate, XDG_CONFIG_HOME: duplicate },
        destinationRoots: [path.join(tmp.path, "destination")],
      }),
    ).rejects.toThrow("duplicate")

    const unreadable = path.join(tmp.path, ".bharatcode")
    await mkdir(unreadable)
    await chmod(unreadable, 0o000)
    try {
      await expect(
        discoverMigrationSources({
          platform: "linux",
          home: tmp.path,
          env: {},
          destinationRoots: [path.join(tmp.path, "destination")],
        }),
      ).rejects.toThrow("readable")
    } finally {
      await chmod(unreadable, 0o700)
    }
  })
})
