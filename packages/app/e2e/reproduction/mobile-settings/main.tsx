import { render } from "solid-js/web"
import { SettingsMobile } from "../../../src/components/settings-mobile"
import { PlatformProvider, type Platform } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import "../../../src/index.css"

// This isolated fixture uses the production component/providers. Only the IPC
// boundary is supplied by each browser test; no real profile or tunnel is used.
const platform: Platform = {
  platform: "desktop",
  os: "linux",
  openExternal() {},
  async restart() {},
  async notify() {},
  async openDirectoryPickerDialog() {
    return null
  },
  async mobileAccess(input) {
    const response = await fetch("/__fixture/mobile", { method: "POST", body: JSON.stringify(input) })
    if (!response.ok) throw new Error("Fixture action failed")
    return response.json()
  },
}

render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="en">
        <SettingsMobile />
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
