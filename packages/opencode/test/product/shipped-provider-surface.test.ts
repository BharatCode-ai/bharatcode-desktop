import { describe, expect, test } from "bun:test"

const root = new URL("../../src/cli/cmd/tui/", import.meta.url)

async function source(path: string) {
  return Bun.file(new URL(path, root)).text()
}

describe("shipped BharatCode provider surface", () => {
  test("does not register or advertise generic provider connections", async () => {
    const app = await source("app.tsx")
    const model = await source("component/dialog-model.tsx")
    const footer = await source("feature-plugins/sidebar/footer.tsx")
    const tips = await source("feature-plugins/home/tips-view.tsx")

    expect(app).not.toContain('name: "provider.connect"')
    expect(app).not.toContain('"provider.connect",')
    expect(app).not.toContain("<DialogProviderList />")
    expect(model).not.toContain("createDialogProviderOptions")
    expect(model).not.toContain("<DialogProvider />")
    expect(model).not.toContain('title: connected() ? "Connect provider" : "View all providers"')
    expect(footer).not.toMatch(/OpenCode|Connect provider|75\+ providers|\/connect/u)
    expect(tips).not.toMatch(/OpenCode Zen|\/connect/u)
  })
})
