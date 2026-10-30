import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "ai.bharatcode.desktop.dev", executable: "bharatcode-dev" },
  { channel: "beta", appId: "ai.bharatcode.desktop.beta", executable: "bharatcode-beta" },
  { channel: "prod", appId: "ai.bharatcode.desktop", executable: "bharatcode" },
] as const

for (const channel of channels) {
  test(`preserves BharatCode install identity, protocol and bundled CLI for ${channel.channel}`, async () => {
    const previous = process.env.BHARATCODE_CHANNEL
    process.env.BHARATCODE_CHANNEL = channel.channel
    try {
      const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
      const config = module.default as Configuration
      expect(config.appId).toBe(channel.appId)
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
