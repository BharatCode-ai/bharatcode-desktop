// Mocked platform only: this entry is not part of the shipped app or an auth acceptance test.
import { render } from "solid-js/web"
import { createEffect, onCleanup } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { DesktopMemoryRouter } from "../../../../desktop/src/renderer/router"
import { AppBaseProviders, AppInterface } from "@/app"
import { PlatformProvider, type Platform } from "@/context/platform"
import { ServerConnection } from "@/context/server"

const server: ServerConnection.Http = {
  type: "http",
  http: {
    url: `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "127.0.0.1"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`,
  },
}
const windowID = new URLSearchParams(location.search).get("window") ?? "browser"
const platform: Platform = {
  platform: "desktop",
  windowID,
  storage: (name = "default.dat") => ({
    async getItem(key) {
      await new Promise((resolve) => setTimeout(resolve, key === "tabs.recent" ? 80 : 20))
      return localStorage.getItem(`${name}:${key}`)
    },
    async setItem(key, value) {
      localStorage.setItem(`${name}:${key}`, value)
    },
    async removeItem(key) {
      localStorage.removeItem(`${name}:${key}`)
    },
  }),
  openExternal() {},
  async restart() {},
  async notify() {},
  async openDirectoryPickerDialog() {
    return null
  },
}
function LocationProbe() {
  const route = useLocation()
  const navigate = useNavigate()
  const handler = (event: Event) => navigate((event as CustomEvent<string>).detail)
  window.addEventListener("fixture:navigate", handler)
  onCleanup(() => window.removeEventListener("fixture:navigate", handler))
  createEffect(() => {
    document.documentElement.dataset.route = route.pathname
  })
  return null
}

render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale="en">
        <AppInterface
          defaultServer={ServerConnection.key(server)}
          canonicalLocalServer={ServerConnection.key(server)}
          servers={[server]}
          disableHealthCheck
          router={(props) => <DesktopMemoryRouter {...props} windowID={windowID} />}
        >
          <LocationProbe />
        </AppInterface>
      </AppBaseProviders>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
