import { expect, test } from "bun:test"
import { createServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { chromium } from "@playwright/test"
import { resolve } from "node:path"
import { STUDENT_VERIFICATION_URL } from "@opencode-ai/core/util/model-recovery"

test("student denial opens only the fixed verification URL, without sign-out or prompt replay", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [solidPlugin(), tailwindcss()],
    resolve: { alias: { "@": resolve("src") } },
    optimizeDeps: { entries: ["test-runtime/student-access.html"] },
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
    for (const width of [1200, 375]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`${server.resolvedUrls!.local[0]}test-runtime/student-access.html`)
      const link = page.getByRole("link", { name: "Verify student email", exact: true })
      await link.waitFor()
      expect(await link.getAttribute("href")).toBe(STUDENT_VERIFICATION_URL)
      expect(await page.locator("body").innerText()).toContain("Lite, Pro or verified student")
      expect(await page.locator("body").innerText()).not.toContain("only available to Pro")
      expect(await page.getByRole("button", { name: "Retry connection" }).count()).toBe(0)
      await link.focus()
      await page.keyboard.press("Enter")
      expect(await page.getByTestId("opened").innerText()).toBe(STUDENT_VERIFICATION_URL)
      expect(await page.getByTestId("calls").innerText()).toBe("1")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (process.env.STUDENT_ACCESS_SCREENSHOTS)
        await page.screenshot({ path: `${process.env.STUDENT_ACCESS_SCREENSHOTS}/student-access-${width}.png` })
      await page.getByRole("button", { name: "Other error", exact: true }).click()
      expect(await link.count()).toBe(0)
      expect(await page.getByTestId("calls").innerText()).toBe("1")
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 60000)
