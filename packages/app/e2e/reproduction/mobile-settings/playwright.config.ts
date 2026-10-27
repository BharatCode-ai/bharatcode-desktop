import { defineConfig } from "@playwright/test"
import config from "../../../playwright.config"

export default defineConfig({
  ...config,
  testDir: "../..",
  testMatch: "mobile-settings.spec.ts",
  outputDir: "../../test-results/mobile-settings",
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: { ...config.use, baseURL: "http://127.0.0.1:3286" },
  webServer: {
    command: "bun run dev -- --host 127.0.0.1 --port 3286 --strictPort",
    cwd: import.meta.dirname + "/../../..",
    url: "http://127.0.0.1:3286/e2e/reproduction/mobile-settings/index.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
