import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { GenericProvider } from "electron-updater/out/providers/GenericProvider"
import { MacUpdater } from "electron-updater/out/MacUpdater"
import { DebUpdater } from "electron-updater/out/DebUpdater"
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater"
import { NsisUpdater } from "electron-updater/out/NsisUpdater"
import { stageFixture } from "./fixtures/desktop-cohort"

test("1.15.46 generic provider resolves staged beta metadata to the exact stable bytes and blockmaps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-legacy-feed-"))
  try {
    const { release, output } = await stageFixture(root)
    const base = "https://github.com/BharatCode-ai/bharatcode-desktop/releases/download/"
    expect(release.compatibility).toBe("desktop-beta-1.15.50")
    expect((await fs.readdir(path.join(output, "compatibility"))).sort()).toEqual([
      "beta-linux.yml",
      "beta-mac.yml",
      "beta.yml",
    ])
    for (const [platform, metadata] of [
      ["win32", "beta.yml"],
      ["darwin", "beta-mac.yml"],
      ["linux", "beta-linux.yml"],
    ]) {
      const provider = new GenericProvider(
        {
          provider: "generic",
          url: base + release.compatibility + "/",
          channel: "beta",
          useMultipleRangeRequests: false,
        },
        { channel: "beta", isAddNoCacheQuery: false },
        {
          platform,
          executor: {
            request(options) {
              expect(options.path).toBe(new URL(base + release.compatibility + "/" + metadata).pathname)
              return fs.readFile(path.join(output, "compatibility", metadata), "utf8")
            },
          },
        },
      )
      const info = await provider.getLatestVersion()
      expect(info.version).toBe("1.15.50")
      const files = provider.resolveFiles(info)
      expect(info.path).toBe(files[0].url.href)
      if (platform === "linux") {
        for (const [Updater, name] of [
          [DebUpdater, "bharatcode-desktop-linux-amd64.deb"],
          [AppImageUpdater, "bharatcode-desktop-linux-x86_64.AppImage"],
        ]) {
          const updater = new Updater(null, { version: "1.15.46" })
          // Run the real package selector; intercept before any disk install or HTTP.
          updater.executeDownload = ({ fileInfo }) => fileInfo.url.href
          expect(await updater.doDownloadUpdate({ updateInfoAndProvider: { provider, info } })).toBe(
            base + release.tag + "/" + name,
          )
        }
      }
      if (platform === "darwin") {
        for (const [arm, arch] of [
          [true, "arm64"],
          [false, "x64"],
        ]) {
          expect(MacUpdater.filterFilesForArch(files, arm).map((file) => file.url.href)).toEqual([
            base + release.tag + "/bharatcode-desktop-mac-" + arch + ".zip",
          ])
        }
      }
      for (const file of files) {
        const name = path.basename(file.url.pathname)
        expect(file.url.href).toBe(base + release.tag + "/" + name)
        const content = await fs.readFile(path.join(output, "stable", name))
        expect(content.length).toBe(file.info.size)
        expect(createHash("sha512").update(content).digest("base64")).toBe(file.info.sha512)
        if (platform === "linux") continue // AppImage has an embedded map.
        const [oldMap, newMap] = await provider.getBlockMapFiles(file.url, "1.15.46", info.version)
        expect(newMap.href).toBe(file.url.href + ".blockmap")
        expect(release.files.some((entry) => entry.name === name + ".blockmap")).toBe(true)
        expect(oldMap.href).toBe(newMap.href.replace("desktop-1.15.50", "desktop-1.15.46"))
        if (platform !== "win32") continue
        // No desktop-1.15.46 stable tag exists. Exercise the pinned updater's
        // actual fallback decision with no old cache, network or real profile.
        const updater = new NsisUpdater(null, { version: "1.15.46" })
        updater.logger = null
        updater.downloadedUpdateHelper = {
          cacheDir: path.join(root, "cache"),
          cacheDirForPendingUpdate: path.join(root, "cache/pending"),
        }
        const requests = []
        updater.httpExecutor = {
          downloadToBuffer(url) {
            requests.push(url.href)
            if (url.href === newMap.href) return fs.readFile(path.join(output, "stable", name + ".blockmap"))
            throw new Error("old stable blockmap not found")
          },
        }
        expect(
          await updater.differentialDownloadInstaller(
            file,
            { updateInfoAndProvider: { provider, info } },
            path.join(root, "unused"),
            provider,
            name,
          ),
        ).toBe(true)
        expect(requests).toEqual([newMap.href, oldMap.href])
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("subsequent stable versions stage no legacy metadata or compatibility tag", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-stable-only-"))
  try {
    const { release, output } = await stageFixture(root, "1.15.51")
    expect(release.compatibility).toBeNull()
    expect(release.compatibilityFiles).toEqual([])
    expect(await fs.readdir(output)).toEqual(["stable"])
    expect(await fs.readdir(path.join(output, "stable"))).not.toContain("beta.yml")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
