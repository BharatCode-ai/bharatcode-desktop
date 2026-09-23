import { test, expect } from "@playwright/test"
import { mockOpenCodeServer } from "./utils/mock-server"
import { fixture, pageMessages } from "./performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./performance/timeline/timeline-test-helpers"
import { base64Encode } from "@opencode-ai/core/util/encode"
import catalog from "../../core/src/capabilities/catalog.json" with { type: "json" }

for (const modern of [false, true]) {
  test(`marketplace preserves state and requires explicit reload in ${modern ? "new" : "legacy"} settings`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    if (!modern) await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"))
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort(),
    )
    await mockOpenCodeServer(page, {
      sessions: structuredClone(fixture.sessions),
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await installStressSessionTabs(page)
    const state = {
      version: 1,
      installed: { "superpowers-obra": { enabled: true } } as Record<string, { enabled: boolean }>,
    }
    let mutations = 0
    let reloads = 0
    await page.route("**/capabilities**", async (route) => {
      const url = new URL(route.request().url())
      if (!url.pathname.startsWith("/capabilities")) return route.fallback()
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            catalog,
            state,
            configuration: {
              scope: "runtime-defaults",
              entries: { github: { enabled: true, custom: mutations === 4 } },
            },
          },
        })
      mutations++
      const id = url.pathname.split("/")[2]
      const action = route.request().postDataJSON().action
      if (action === "uninstall") delete state.installed[id]
      else state.installed[id] = { enabled: action === "enable" }
      if (mutations === 2) return route.fulfill({ status: 503, json: { message: "secret-token=/private/config" } })
      return route.fulfill({ json: { state, reloadRequired: true } })
    })
    await page.route("**/global/dispose", async (route) => {
      reloads++
      await route.fulfill({ json: true })
    })
    await page.addInitScript((enabled) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.31" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: enabled } }))
    }, modern)
    await page.goto(
      modern ? stressSessionHref(fixture.sourceID) : `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`,
    )
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
    await page.keyboard.press("Control+,")
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible()
    await page.getByRole("tab", { name: "Marketplace", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Marketplace", exact: true })).toBeVisible()
    await expect(page).toHaveTitle("BharatCode")
    await expect(page.getByText("BharatCode Desktop", { exact: true })).toBeVisible()
    await expect(page.getByText("OpenCode Desktop", { exact: true })).toHaveCount(0)
    const github = page.getByRole("region", { name: "GitHub", exact: true })
    await expect(github.getByRole("button", { name: "Install GitHub", exact: true })).toBeEnabled()
    await github.getByRole("button", { name: "Install GitHub", exact: true }).click()
    await expect(github).toContainText("Disabled in settings")
    expect(reloads).toBe(0)
    await github.getByRole("button", { name: "Enable GitHub", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveText(
      "The change could not be confirmed. Refresh to check saved settings before trying again.",
    )
    await expect(github.getByRole("button", { name: "Enable GitHub", exact: true })).toBeDisabled()
    await expect(page.getByText("Saved — reload to apply.", { exact: true })).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText("secret-token")
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(github).toContainText("Enabled in settings")
    await github.getByRole("button", { name: "Disable GitHub", exact: true }).click()
    await expect(github).toContainText("Disabled in settings")
    await github.getByRole("button", { name: "Remove GitHub", exact: true }).click()
    await expect(github.getByRole("button", { name: "Install GitHub", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(github).toContainText(
      "Custom runtime configuration enables this capability. Project settings may differ.",
    )
    await github.getByText("Access and requirements", { exact: true }).click()
    await expect(github).toContainText("Third-party connector")
    await expect(github).toContainText("Connected account access")
    await page.getByRole("button", { name: "Reload runtime", exact: true }).click()
    await expect(
      page.getByText("Reloading interrupts active sessions on this runtime. Continue?", { exact: true }),
    ).toBeVisible()
    expect(reloads).toBe(0)
    await page.getByRole("button", { name: "Reload now", exact: true }).click()
    await expect(page.getByText("Saved — reload to apply.", { exact: true })).toHaveCount(0)
    expect(reloads).toBe(1)
    expect(mutations).toBe(4)
    await page.screenshot({ path: `/tmp/bc-marketplace-${modern ? "new" : "legacy"}.png` })
    expect(errors).toEqual([])
  })
}
