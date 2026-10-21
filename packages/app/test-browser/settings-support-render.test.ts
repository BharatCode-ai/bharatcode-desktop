import { expect, test } from "bun:test"
import { createServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import { chromium } from "@playwright/test"
import { resolve } from "node:path"

test("both support settings layouts export safely and hide unsupported platforms", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [solidPlugin()],
    resolve: { alias: { "@": resolve("src") } },
    optimizeDeps: { entries: ["test-runtime/settings-support.html"] },
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true }).catch(async (error: unknown) => {
    await server.close()
    throw error
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    for (const layout of ["", "?v2"]) {
      await page.goto(`${server.resolvedUrls!.local[0]}test-runtime/settings-support.html${layout}`)
      const action = page.getByRole("button", { name: "Export support bundle", exact: true })
      await action.waitFor()
      await action.click()
      expect(await page.getByRole("button", { name: "Saving support bundle…" }).isDisabled()).toBe(true)
      expect(await page.locator("output").innerText()).toBe("1")
      await page.getByRole("button", { name: "Fail fixture export" }).click()
      await page.getByRole("status").filter({ hasText: "Could not save" }).waitFor()
      expect(await page.locator("body").innerText()).not.toContain("sk-private")
      await action.click()
      await page.getByRole("button", { name: "Complete fixture export" }).click()
      await page.getByRole("status").filter({ hasText: "saved to Downloads" }).waitFor()
      expect(await page.locator("body").innerText()).not.toContain("/private/home")
      expect(await page.locator("output").innerText()).toBe("2")
    }
    for (const query of ["?web", "?unsupported"]) {
      await page.goto(`${server.resolvedUrls!.local[0]}test-runtime/settings-support.html${query}`)
      await page.getByRole("button", { name: "Complete fixture export" }).waitFor()
      expect(await page.locator('[data-component="settings-support"]').count()).toBe(0)
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)
