import { expect, test } from "bun:test"
import { createRuntimeAccounts } from "./runtime-accounts"

function fixture() {
  const events: Array<{ id: string; status: { revision?: number } }> = []
  const opened: string[] = []
  const registry = createRuntimeAccounts({
    changed: (id, status) => events.push({ id, status }),
    openBrowser: async (url) => {
      opened.push(url)
    },
  })
  const clients = new Map<string, string[]>()
  const client = (id: string) => {
    const calls: string[] = []
    clients.set(id, calls)
    const signedOut = { state: "signed_out" as const, authenticated: false, checkedAt: "now" }
    return {
      getAccountStatus: async () => {
        calls.push("status")
        return signedOut
      },
      beginSignIn: async () => {
        calls.push("begin")
        return { url: `https://issuer.test/authorize?state=${id}`, expiresAt: Date.now() + 180000 }
      },
      completeSignIn: async () => {
        calls.push("complete")
        return { state: "signed_in" as const, authenticated: true, checkedAt: "now" }
      },
      logout: async () => {
        calls.push("logout")
        return signedOut
      },
    }
  }
  return { registry, client, clients, events, opened }
}

test("status, logout and callbacks stay with the initiating runtime", async () => {
  const f = fixture()
  f.registry.bind("sidecar", f.client("native"))
  f.registry.bind("wsl:Ubuntu", f.client("linux"))
  await f.registry.getAccountStatus("wsl:Ubuntu")
  await f.registry.logout("wsl:Ubuntu")
  const native = f.registry.beginSignIn()
  const linux = f.registry.beginSignIn({}, "wsl:Ubuntu")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.opened).toHaveLength(2)
  await f.registry.completeSignIn("bharatcode://auth/callback?state=linux&code=synthetic")
  expect((await linux).authenticated).toBe(true)
  expect(f.clients.get("native")).toEqual(["begin"])
  expect(f.clients.get("linux")).toEqual(["status", "logout", "begin", "complete"])
  await f.registry.completeSignIn("bharatcode://auth/callback?state=native&code=synthetic")
  expect((await native).authenticated).toBe(true)
  await expect(f.registry.completeSignIn("bharatcode://auth/callback?state=linux&code=synthetic")).rejects.toThrow()
  await expect(f.registry.getAccountStatus("https://unowned.test")).rejects.toThrow()
  f.registry.dispose()
})

test("replacement rejects old replies/callbacks and preserves increasing per-runtime revisions", async () => {
  const f = fixture()
  const read = Promise.withResolvers<{ state: "signed_in"; authenticated: true; checkedAt: string }>()
  f.registry.bind("wsl:Ubuntu", { ...f.client("old"), getAccountStatus: () => read.promise })
  const pending = f.registry.getAccountStatus("wsl:Ubuntu")
  const login = f.registry.beginSignIn({}, "wsl:Ubuntu").catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const before = f.events.at(-1)!.status.revision!
  f.registry.bind("wsl:Ubuntu", f.client("new"))
  read.resolve({ state: "signed_in", authenticated: true, checkedAt: "old" })
  await expect(pending).rejects.toThrow()
  await login
  await expect(f.registry.completeSignIn("bharatcode://auth/callback?state=old&code=synthetic")).rejects.toThrow()
  const current = await f.registry.getAccountStatus("wsl:Ubuntu")
  expect(current.state).toBe("signed_out")
  expect(current.revision!).toBeGreaterThan(before)
  expect(f.clients.get("new")).toEqual(["status"])
  f.registry.bind("wsl:Ubuntu")
  await expect(f.registry.logout("wsl:Ubuntu")).rejects.toThrow()
  f.registry.dispose()
})
