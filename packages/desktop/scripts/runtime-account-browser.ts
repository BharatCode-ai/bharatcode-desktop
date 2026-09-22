// Run from packages/app: bun ../desktop/scripts/runtime-account-browser.ts
import { createServer } from "../../app/node_modules/vite"
import { chromium, expect } from "../../app/node_modules/@playwright/test"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = fileURLToPath(new URL("../../app/", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/runtime-account.tsx", import.meta.url))
const server = await createServer({
  root,
  configFile: join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "runtime-account-fixture",
      configureServer(server) {
        server.middlewares.use("/__runtime-account", (_request, response) => {
          response.setHeader("Content-Type", "text/html")
          response.end(
            `<html><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
          )
        })
      },
    },
  ],
})
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const failures: string[] = []
  page.on("pageerror", (error) => failures.push(error.message))
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  )
  const address = server.httpServer!.address() as { port: number }
  await page.goto(`http://127.0.0.1:${address.port}/__runtime-account`)
  const workspace = page.getByRole("region", { name: "Authenticated workspace" })
  await expect(workspace).toContainText("sidecar", { timeout: 30000 })
  await page.getByRole("button", { name: "Select Ubuntu", exact: true }).click()
  const signIn = page.getByRole("button", { name: "Continue with BharatCode", exact: true })
  await expect(signIn).toBeDisabled()
  // A native account event cannot unlock the WSL gate.
  await page.evaluate(() => (window as any).accountFixture.publish("sidecar", true, 8))
  await expect(workspace).toHaveCount(0)
  // A newer WSL event must win over an older pending read.
  await page.evaluate(() => (window as any).accountFixture.publish("wsl:Ubuntu", true, 4))
  await expect(workspace).toContainText("wsl:Ubuntu")
  await page.evaluate(() => (window as any).accountFixture.resolveRead())
  await expect(workspace).toContainText("wsl:Ubuntu")
  await page.getByRole("button", { name: "Synthetic logout", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).accountFixture.calls))
    .toContainEqual(["logout", "wsl:Ubuntu"])
  await page.evaluate(() => (window as any).accountFixture.publish("wsl:Ubuntu", false, 5))
  await expect(signIn).toBeEnabled()
  await signIn.click()
  await expect(page.getByRole("alert")).toContainText("could not be completed")
  await expect
    .poll(() => page.evaluate(() => (window as any).accountFixture.calls))
    .toContainEqual(["sign-in", "wsl:Ubuntu"])
  await page.screenshot({ path: join(tmpdir(), "bc-runtime-account-gate.png") })
  await page.getByRole("button", { name: "Return to local runtime", exact: true }).click()
  await expect(workspace).toContainText("sidecar")
  await page.evaluate(() => (window as any).accountFixture.publish("wsl:Ubuntu", true, 6))
  await expect(workspace).toContainText("sidecar")
  await page.getByRole("button", { name: "Dispose fixture", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).accountFixture.listeners()))
    .toEqual([
      ["sidecar", 0],
      ["wsl:Ubuntu", 0],
    ])
  expect(failures).toEqual([])
  console.log(
    "RUNTIME_ACCOUNT_RENDERER_PASS: scoped gate/actions, stale read, cross-runtime events, return-local, disposal",
  )
} finally {
  await browser.close()
  await server.close()
}
