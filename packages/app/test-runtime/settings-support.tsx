import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { SettingsSupport } from "../src/components/settings-support"
import { PlatformProvider, type Platform } from "../src/context/platform"
import { LanguageProvider } from "../src/context/language"

const params = new URLSearchParams(location.search)
const [state, setState] = createStore({ calls: 0 })
let complete: (() => void) | undefined
let fail: (() => void) | undefined
const platform: Platform = {
  platform: "desktop",
  os: "linux",
  openDirectoryPickerDialog: async () => null,
  openExternal: () => {},
  restart: async () => {},
  notify: async () => {},
  exportDebugLogs: () => {
    setState("calls", (value) => value + 1)
    return new Promise<string>((resolve, reject) => {
      complete = () => resolve("/private/home/support.zip")
      fail = () => reject(new Error("sk-private owner@private.test"))
    })
  },
}
if (params.has("unsupported")) delete platform.exportDebugLogs
const value: Platform = params.has("web") ? { ...platform, platform: "web", os: undefined } : platform
render(
  () => (
    <PlatformProvider value={value}>
      <LanguageProvider locale="en">
        <SettingsSupport v2={params.has("v2")} />
        <button onClick={() => complete?.()}>Complete fixture export</button>
        <button onClick={() => fail?.()}>Fail fixture export</button>
        <output>{state.calls}</output>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
