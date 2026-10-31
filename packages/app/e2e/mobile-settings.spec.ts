import { expect, test, type Page } from "@playwright/test"
import type { MobileAction, MobileState } from "../src/mobile-types"

const fixture = "/e2e/reproduction/mobile-settings/index.html"
const off: MobileState = { enabled: false, connecting: false, status: "off", devices: [], requests: [] }

async function serve(page: Page, initial: MobileState, change?: (action: MobileAction) => Promise<MobileState>) {
  await page.route("**/__fixture/mobile", async (route) => {
    const input = route.request().postDataJSON() as MobileAction
    const state = input.type === "state" || !change ? initial : await change(input)
    await route.fulfill({ json: state })
  })
}

test("storage errors are visible without exposing the stored data", async ({ page }) => {
  await serve(page, { ...off, status: "error", errorKey: "mobile.error.storage" })
  await page.goto(fixture)
  await expect(page.getByRole("alert")).toHaveText(
    "Mobile-device storage is unavailable. Your existing device data has been kept. Check storage access and try again.",
  )
  await expect(page.getByRole("button", { name: "Connect phone", exact: true })).toBeEnabled()
})

test("Reset remains usable during provisioning and completes without a separate Cancel", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  let began: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  let state = { ...off }
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/__fixture/mobile", async (route) => {
    const action = route.request().postDataJSON() as MobileAction
    if (action.type === "pair") {
      state = { ...off, status: "provisioning", connecting: true }
      began()
      await pending
      await route.fulfill({ status: 409, json: { error: "cancelled pairing" } })
      return
    }
    if (action.type === "reset") {
      state = { ...off }
      release()
    }
    await route.fulfill({ json: state })
  })
  await page.goto(fixture)
  await expect(page.getByRole("button", { name: "Connect phone", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Connect phone", exact: true }).click()
  await started
  await page.clock.runFor(1500)
  await expect(page.getByRole("button", { name: "Cancel connection", exact: true })).toBeVisible()
  const reset = page.getByRole("button", { name: "Revoke all phones and reset tunnel", exact: true })
  await expect(reset).toBeEnabled()
  page.once("dialog", (dialog) => dialog.accept())
  await reset.click()
  await expect(page.getByRole("button", { name: "Connect phone", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Cancel connection", exact: true })).toHaveCount(0)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByText("No phones paired yet.", { exact: true })).toBeVisible()
})

test("shows the matching code and approves only the selected request", async ({ page }) => {
  const waiting: MobileState = {
    ...off,
    enabled: true,
    status: "connected",
    requests: [{ claimID: "claim-qa", name: "QA phone", confirmation: "572019", expiresAt: Date.now() + 300000 }],
  }
  await serve(page, waiting, async (action) => {
    expect(action).toEqual({ type: "approve", id: "claim-qa" })
    Object.assign(waiting, { requests: [], devices: [{ id: "device-qa", name: "QA phone", pairedAt: 1 }] })
    return waiting
  })
  await page.goto(fixture)
  await expect(page.getByText("572019", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Approve only if this code matches the one on your phone.", { exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Approve phone", exact: true }).click()
  await expect(page.getByText("572019", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled()
  await expect(page.getByText("QA phone", { exact: true })).toHaveCount(1)
})

test("revocation requires confirmation and removes the selected phone", async ({ page }) => {
  const paired: MobileState = { ...off, devices: [{ id: "device-qa", name: "QA phone", pairedAt: 1 }] }
  await serve(page, paired, async (action) => {
    expect(action).toEqual({ type: "revoke", id: "device-qa" })
    paired.devices = []
    return paired
  })
  await page.goto(fixture)
  const revoke = page.getByRole("button", { name: "Revoke access", exact: true })
  await expect(revoke).toBeEnabled()
  page.once("dialog", (dialog) => dialog.dismiss())
  await revoke.click()
  await expect(page.getByText("QA phone", { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await revoke.click()
  await expect(page.getByText("QA phone", { exact: true })).toHaveCount(0)
  await expect(page.getByText("No phones paired yet.", { exact: true })).toBeVisible()
})

test("decline removes a pending request without pairing it", async ({ page }) => {
  const waiting: MobileState = {
    ...off,
    enabled: true,
    status: "connected",
    requests: [
      { claimID: "declined-qa", name: "Unapproved phone", confirmation: "109275", expiresAt: Date.now() + 300000 },
    ],
  }
  await serve(page, waiting, async (action) => {
    expect(action).toEqual({ type: "decline", id: "declined-qa" })
    waiting.requests = []
    return waiting
  })
  await page.goto(fixture)
  await expect(page.getByText("109275", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Decline", exact: true }).click()
  await expect(page.getByText("109275", { exact: true })).toHaveCount(0)
  await expect(page.getByText("No phones paired yet.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Revoke access", exact: true })).toHaveCount(0)
})
