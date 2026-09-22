import { createAccountSession } from "./account-session"
import type { BharatCodeAccountStatus } from "../preload/types"
import { nativeT } from "./native-translations"

type Client = Parameters<typeof createAccountSession>[0]["client"]
type Entry = { session: ReturnType<typeof createAccountSession>; latest: BharatCodeAccountStatus }

// Each entry captures one runtime connection. Replacing a runtime disposes its
// pending OAuth transaction; it never transfers that transaction or credential
// operations to the replacement process or another credential store.
export function createRuntimeAccounts(options: {
  openBrowser: (url: string) => Promise<unknown>
  changed: (runtimeId: string, status: BharatCodeAccountStatus) => void
}) {
  const entries = new Map<string, Entry>()
  const revisions = new Map<string, number>()
  const unavailable = () => new Error(nativeT("desktop.account.error.unavailable"))
  const notify = (id: string, status: BharatCodeAccountStatus) => {
    const revision = (revisions.get(id) ?? 0) + 1
    revisions.set(id, revision)
    const next = { ...status, revision }
    try {
      options.changed(id, next)
    } catch {
      /* A closing window reads again on reopen. */
    }
    return next
  }
  const get = (id: unknown = "sidecar") => {
    if (typeof id !== "string") throw unavailable()
    const entry = entries.get(id)
    if (!entry) throw unavailable()
    return { id, entry }
  }
  const invoke = async (id: unknown, action: (session: Entry["session"]) => Promise<unknown>) => {
    const current = get(id)
    await action(current.entry.session)
    if (entries.get(current.id) !== current.entry) throw unavailable()
    return current.entry.latest
  }
  return {
    bind(id: string, client?: Client) {
      if (id !== "sidecar" && !id.startsWith("wsl:")) throw unavailable()
      entries.get(id)?.session.dispose()
      entries.delete(id)
      const latest = notify(id, {
        state: "connection_issue",
        authenticated: false,
        checkedAt: new Date().toISOString(),
      })
      if (!client) return
      const entry: Entry = {
        latest,
        session: createAccountSession({
          client,
          openBrowser: options.openBrowser,
          changed: (status) => {
            if (entries.get(id) === entry) entry.latest = notify(id, status)
          },
        }),
      }
      entries.set(id, entry)
    },
    getAccountStatus: (id?: unknown) => invoke(id, (session) => session.getAccountStatus()),
    refreshAccountStatus: (id?: unknown) => invoke(id, (session) => session.refreshAccountStatus()),
    beginSignIn: (input: { selectAccount?: boolean } = {}, id?: unknown) =>
      invoke(id, (session) => session.beginSignIn(input)),
    logout: (id?: unknown) => invoke(id, (session) => session.logout()),
    cancelSignIn(id?: unknown) {
      get(id).entry.session.cancelSignIn()
    },
    async completeSignIn(callbackUrl: string) {
      const owners = [...entries].filter(([, entry]) => entry.session.acceptsCallback(callbackUrl))
      if (owners.length !== 1) throw unavailable()
      return invoke(owners[0][0], (session) => session.completeSignIn(callbackUrl))
    },
    dispose() {
      for (const entry of entries.values()) entry.session.dispose()
      entries.clear()
    },
  }
}
