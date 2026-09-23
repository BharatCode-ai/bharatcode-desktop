import config from "../../../playwright.config"
export default {
  ...config,
  testDir: "../..",
  testMatch: "startup-restore.spec.ts",
  outputDir: "../../test-results/startup-restore",
  workers: 1,
  reporter: [["line"]],
  use: { ...config.use, baseURL: "http://127.0.0.1:3284" },
  webServer: {
    command: "bun run dev -- --host 127.0.0.1 --port 3284 --strictPort",
    cwd: import.meta.dirname + "/../../..",
    url: "http://127.0.0.1:3284/e2e/reproduction/startup/index.html",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_OPENCODE_SERVER_HOST: process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1",
      VITE_OPENCODE_SERVER_PORT: process.env.PLAYWRIGHT_SERVER_PORT ?? "4096",
    },
  },
}
