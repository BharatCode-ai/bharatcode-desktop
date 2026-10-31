import { expect, test } from "bun:test"
import config, { assertPackagingPolicy } from "../electron-builder.config"
import { bundledCliFilename } from "./utils"

test("Windows installer cannot silently replace the pinned build runtime", async () => {
  const action = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/actions/setup-bun/action.yml", import.meta.url)).text(),
  ) as {
    runs: { steps: { name: string; if?: string; run?: string; with?: Record<string, string> }[] }
  }
  const steps = action.runs.steps
  const installer = steps.findIndex((step) => step.name === "Setup Windows dependency installer")
  const install = steps.findIndex((step) => step.name === "Install dependencies")
  const restore = steps.findIndex((step) => step.name === "Restore pinned Bun runtime after Windows install")
  expect(installer).toBeGreaterThan(-1)
  expect(install).toBeGreaterThan(installer)
  expect(restore).toBeGreaterThan(install)
  expect(steps[installer].if).toBe("runner.os == 'Windows'")
  expect(steps[installer].with?.["bun-version"]).toBe("1.4.2")
  expect(steps[restore].with?.["bun-download-url"]).toBe("${{ steps.bun-url.outputs.url }}")
  expect(steps.at(-1)?.run).toContain("packageManager.split")
  expect(steps.at(-1)?.run).toContain("bun --version")
})

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
