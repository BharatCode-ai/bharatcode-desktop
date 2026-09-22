// Synthetic renderer-only acceptance fixture. No Electron, OAuth or credential store.
import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { AppBaseProviders, PlatformProvider, usePlatform, type Platform } from "@opencode-ai/app"
import { ServerConnection, ServerProvider, useServer } from "../../../app/src/context/server"
import type { BharatCodeAccountStatus, ElectronAPI } from "../../src/preload/types"
import { RuntimeAccountBoundary } from "../../src/renderer/account-gate"
import { runtimeAccountApi } from "../../src/renderer/runtime-account"

const signed = (authenticated: boolean, revision = 1): BharatCodeAccountStatus => ({
  state: authenticated ? "signed_in" : "signed_out",
  authenticated,
  checkedAt: "synthetic",
  revision,
})
const listeners = new Map<string, Set<(status: BharatCodeAccountStatus) => void>>()
const calls: Array<[string, string]> = []
const statuses = new Map([
  ["sidecar", signed(true)],
  ["wsl:Ubuntu", signed(false)],
])
let delayed: ((value: BharatCodeAccountStatus) => void) | undefined
const api = {
  getAccountStatus: async (id: string) => {
    calls.push(["read", id])
    if (id === "wsl:Ubuntu")
      return new Promise<BharatCodeAccountStatus>((resolve) => {
        delayed = resolve
      })
    return statuses.get(id)!
  },
  beginSignIn: async ({ runtimeId }: { runtimeId: string }) => {
    calls.push(["sign-in", runtimeId])
    throw new Error("synthetic transport failure")
  },
  refreshAccountStatus: async (id: string) => statuses.get(id)!,
  cancelSignIn: async () => {},
  logout: async (id: string) => {
    calls.push(["logout", id])
    return signed(false)
  },
  onAccountStatusChanged: (fn: (status: BharatCodeAccountStatus) => void, id: string) => {
    const set = listeners.get(id) ?? new Set()
    listeners.set(id, set)
    set.add(fn)
    return () => set.delete(fn)
  },
} as unknown as ElectronAPI
const platform: Platform = {
  platform: "desktop",
  os: "windows",
  openExternal() {},
  restart: async () => {},
  notify: async () => {},
  ...runtimeAccountApi(api, "sidecar"),
  accountForServer: (id) => runtimeAccountApi(api, id),
}
Object.assign(window, {
  accountFixture: {
    calls,
    publish(id: string, value: boolean, revision: number) {
      const status = signed(value, revision)
      statuses.set(id, status)
      listeners.get(id)?.forEach((fn) => fn(status))
    },
    resolveRead() {
      delayed?.(signed(false))
      delayed = undefined
    },
    listeners: () => [...listeners].map(([id, set]) => [id, set.size]),
  },
})
function Content() {
  const account = usePlatform()
  const server = useServer()
  return (
    <section aria-label="Authenticated workspace">
      <p>{server.key}</p>
      <button onClick={() => void account.logout?.()}>Synthetic logout</button>
    </section>
  )
}
function Fixture() {
  const server = useServer()
  const [mounted, setMounted] = createSignal(true)
  return (
    <>
      <button onClick={() => server.setActive(ServerConnection.Key.make("wsl:Ubuntu"))}>Select Ubuntu</button>
      <button onClick={() => server.setActive(ServerConnection.Key.make("sidecar"))}>Select local</button>
      <button onClick={() => setMounted(false)}>Dispose fixture</button>
      <Show when={mounted()}>
        <RuntimeAccountBoundary>
          <Content />
        </RuntimeAccountBoundary>
      </Show>
    </>
  )
}
render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale="en">
        <ServerProvider
          defaultServer={ServerConnection.Key.make("sidecar")}
          servers={[
            { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:1" } },
            { type: "sidecar", variant: "wsl", distro: "Ubuntu", http: { url: "http://127.0.0.1:2" } },
          ]}
        >
          <Fixture />
        </ServerProvider>
      </AppBaseProviders>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
