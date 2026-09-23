import { expect, test } from "bun:test"
import config, { assertPackagingPolicy } from "../electron-builder.config"
import { bundledCliFilename } from "./utils"

test("packaging cannot substitute an upstream product, protocol, CLI or update destination", () => {
  expect(config.appId).toStartWith("ai.bharatcode.desktop")
  expect(config.productName).toStartWith("BharatCode")
  expect(config.protocols).toEqual({ name: "BharatCode", schemes: ["bharatcode"] })
  expect(JSON.stringify(config)).not.toMatch(/anomalyco|opencode-cli|opencode-desktop/)
  expect(bundledCliFilename("win32")).toBe("bharatcode-cli.exe")
  expect(bundledCliFilename("linux")).toBe("bharatcode-cli")
  expect(config.mac?.hardenedRuntime).toBe(true)
  expect(config.mac?.extendInfo?.NSMicrophoneUsageDescription).toBeTruthy()
  expect(config.linux?.target).toEqual(["AppImage", "deb"])
  expect(config.win?.extraResources).toEqual([{ from: "resources/wsl-runtime", to: "wsl-runtime", filter: ["*"] }])
  expect(config.files).toContain("!resources/wsl-runtime/**/*")
})

test("unsigned Windows is explicit and macOS release signing plus notarization is mandatory", () => {
  expect(() => assertPackagingPolicy("win32", {}, "beta")).toThrow("unsigned")
  expect(() => assertPackagingPolicy("win32", { BHARATCODE_ALLOW_UNSIGNED_WINDOWS: "1" }, "beta")).not.toThrow()
  expect(() => assertPackagingPolicy("darwin", {}, "beta")).toThrow("Developer ID")
  expect(() => assertPackagingPolicy("darwin", { CSC_LINK: "test" }, "beta")).toThrow("notarization")
  expect(() =>
    assertPackagingPolicy(
      "darwin",
      { CSC_LINK: "test", APPLE_API_KEY: "test", APPLE_API_KEY_ID: "test", APPLE_API_ISSUER: "test" },
      "beta",
    ),
  ).not.toThrow()
  expect(() => assertPackagingPolicy("linux", {}, "beta")).not.toThrow()
})
