import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "ai.bharatcode.desktop.dev", executable: "bharatcode-dev" },
  { channel: "beta", appId: "ai.bharatcode.desktop.beta", executable: "bharatcode-beta" },
  { channel: "prod", appId: "ai.bharatcode.desktop.beta", executable: "bharatcode-beta" },
] as const

for (const channel of channels) {
  test(`preserves BharatCode install identity, protocol and bundled CLI for ${channel.channel}`, async () => {
    const previous = process.env.BHARATCODE_CHANNEL
    process.env.BHARATCODE_CHANNEL = channel.channel
    try {
      const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
      const config = module.default as Configuration
      expect(config.appId).toBe(channel.appId)
      const installed = channel.channel === "dev" ? "BharatCode Dev" : "BharatCode Beta"
      expect(config.productName).toBe(channel.channel === "prod" ? "BharatCode" : installed)
      expect(config.win?.executableName).toBe(installed)
      expect(config.mac?.executableName).toBe(installed)
      expect(config.nsis).toMatchObject({ oneClick: true, perMachine: false, deleteAppDataOnUninstall: false })
      if (channel.channel !== "dev") expect(config.nsis?.guid).toBe("7482e884-fa37-5b72-9a66-4f82ac598969")
      expect(config.deb?.packageName).toBe(channel.executable)
      expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
      expect(config.linux?.executableName).toBe(channel.executable)
      expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
      expect(config.deb?.fpm).toContainEqual(
        expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`),
      )
      expect(config.protocols).toEqual({ name: "BharatCode", schemes: ["bharatcode"] })
      expect(config.files).toContain("!resources/bharatcode-cli*")
      expect(config.extraResources).toContainEqual({ from: "resources/", to: "", filter: ["bharatcode-cli*"] })
      expect(config.win?.target).toEqual(["nsis"])
      expect(config.win?.verifyUpdateCodeSignature).toBe(false)
      expect(config.win?.signtoolOptions?.sign).toBeFunction()
      expect(() => module.assertPackagingPolicy("win32", {})).toThrow("unsigned")
      expect(() => module.assertPackagingPolicy("win32", { BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "0" })).toThrow(
        "unsigned",
      )
      expect(() => module.assertPackagingPolicy("win32", { BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "1" })).not.toThrow()
      expect(config.linux?.target).toEqual(["AppImage", "deb"])
      expect(config.publish).toEqual(
        channel.channel === "dev"
          ? undefined
          : {
              provider: "github",
              owner: "BharatCode-ai",
              repo: "bharatcode-desktop",
              channel: channel.channel === "beta" ? "beta" : "latest",
            },
      )
    } finally {
      if (previous === undefined) delete process.env.BHARATCODE_CHANNEL
      else process.env.BHARATCODE_CHANNEL = previous
    }
  })
}
