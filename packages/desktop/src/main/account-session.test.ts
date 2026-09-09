import { expect, test } from "bun:test"
import { createAccountSession } from "./account-session"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const signedOut = { state: "signed_out" as const, authenticated: false, checkedAt: "now" }
const signedIn = { state: "signed_in" as const, authenticated: true, checkedAt: "now", email: "new@example.test" }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function fixture() {
  const events: unknown[] = []
  const opened: string[] = []
  const calls: string[] = []
  let stored = signedOut as typeof signedOut | typeof signedIn
  let exchange: Promise<void> = Promise.resolve()
  let status: (() => Promise<typeof stored>) | undefined
  let timeout: (() => void) | undefined
  let cleared = 0
  let count = 0
  const session = createAccountSession({
    client: {
      getAccountStatus: async () => (status ? status() : stored),
      beginSignIn: async () => ({
        url: `https://issuer.test/authorize?state=state-${++count}`,
        expiresAt: Date.now() + 180_000,
      }),
      completeSignIn: async () => {
        calls.push("callback")
        await exchange
        stored = signedIn
        return stored
      },
      logout: async () => {
        calls.push("logout")
        stored = signedOut
        return stored
      },
    },
    openBrowser: async (url) => {
      opened.push(url)
    },
    changed: (status) => events.push(status),
    schedule: (fn) => {
      timeout = fn
      return () => {
        cleared++
      }
    },
  })
  return {
    session,
    events,
    opened,
    calls,
    timeout: () => timeout?.(),
    cleared: () => cleared,
    setExchange: (value: Promise<void>) => {
      exchange = value
    },
    setStatus: (value: () => Promise<typeof stored>) => {
      status = value
    },
  }
}

test("browser opening and pending signed_out never complete sign-in; callback resolves and notifies", async () => {
  const f = fixture()
  let settled = false
  const login = f.session.beginSignIn().then((value) => {
    settled = true
    return value
  })
  await tick()
  expect(f.opened).toHaveLength(1)
  expect((await f.session.getAccountStatus()).state).toBe("authorizing")
  expect(settled).toBe(false)
  await f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=private-code")
  expect((await login).state).toBe("signed_in")
  expect(f.cleared()).toBeGreaterThan(0)
  expect(JSON.stringify(f.events)).not.toMatch(/state-1|private-code|issuer|access_token|refresh_token/)
})

test("old signed-in account cannot complete a switch before its callback", async () => {
  const f = fixture()
  f.setStatus(async () => signedIn)
  const login = f.session.beginSignIn({ selectAccount: true }).catch((e: Error) => e.message)
  await tick()
  expect((await f.session.getAccountStatus()).state).toBe("switching")
  await f.session.logout()
  expect(await login).toMatch(/cancelled/)
})

test("superseded and duplicate callbacks cannot exchange or complete a newer attempt", async () => {
  const f = fixture()
  const first = f.session.beginSignIn().catch((e: Error) => e.message)
  await tick()
  const second = f.session.beginSignIn()
  await tick()
  expect(await first).toMatch(/cancelled/)
  await expect(f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=old")).rejects.toThrow()
  expect(f.calls).toEqual([])
  await f.session.completeSignIn("bharatcode://auth/callback?state=state-2&code=new")
  expect((await second).authenticated).toBe(true)
  await expect(f.session.completeSignIn("bharatcode://auth/callback?state=state-2&code=new")).rejects.toThrow()
  expect(f.calls).toEqual(["callback"])
})

test("logout during exchange removes credentials afterward and suppresses stale success", async () => {
  const f = fixture()
  const exchange = deferred<void>()
  f.setExchange(exchange.promise)
  const login = f.session.beginSignIn().catch((e: Error) => e.message)
  await tick()
  const callback = f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=code").catch(() => undefined)
  await tick()
  const logout = f.session.logout()
  expect(await login).toMatch(/cancelled/)
  exchange.resolve()
  await callback
  expect((await logout).state).toBe("signed_out")
  expect(f.calls).toEqual(["callback", "logout"])
  expect(f.events.some((e) => (e as typeof signedIn).state === "signed_in")).toBe(false)
})

test("stale in-flight status cannot overwrite newer sign-in state", async () => {
  const f = fixture()
  const old = deferred<typeof signedOut>()
  f.setStatus(() => old.promise)
  const read = f.session.getAccountStatus()
  const login = f.session.beginSignIn()
  await tick()
  await f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=code")
  const accepted = await login
  old.resolve(signedOut)
  expect(await read).toEqual(accepted)
})

test("timeout rejects safely, cancels callback admission and clears timer", async () => {
  const f = fixture()
  const login = f.session.beginSignIn().catch((e: Error) => e.message)
  await tick()
  f.timeout()
  expect(await login).toMatch(/Timed out/)
  await expect(f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=code")).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(f.cleared()).toBeGreaterThan(0)
})

test("dispose settles pending caller without success", async () => {
  const f = fixture()
  const login = f.session.beginSignIn().catch((e: Error) => e.message)
  await tick()
  f.session.dispose()
  expect(await login).toMatch(/cancelled/)
  expect(f.cleared()).toBeGreaterThan(0)
})

test("window cancellation during exchange removes its late result before reuse", async () => {
  const f = fixture()
  const exchange = deferred<void>()
  f.setExchange(exchange.promise)
  const login = f.session.beginSignIn().catch((e: Error) => e.message)
  await tick()
  const callback = f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=code").catch(() => undefined)
  await tick()
  f.session.cancelSignIn()
  expect(await login).toMatch(/cancelled/)
  exchange.resolve()
  await callback
  expect(f.calls).toEqual(["callback", "logout"])
  expect((await f.session.getAccountStatus()).state).toBe("signed_out")
})

test("callback errors reject the waiting caller with value-free errors, never success", async () => {
  const f = fixture()
  const login = f.session.beginSignIn().catch((e: Error) => e.message)
  await tick()
  const rejected = Promise.reject(new Error("private-token-in-transport-error"))
  void rejected.catch(() => undefined)
  f.setExchange(rejected)
  await expect(f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=private-code")).rejects.toThrow(
    "could not be completed",
  )
  expect(await login).toBe("BharatCode sign-in could not be completed. Try again.")
  expect(JSON.stringify(f.events)).not.toMatch(/private-token|private-code/)
  expect(f.events.some((e) => (e as typeof signedIn).state === "signed_in")).toBe(false)
})

test("late subscribers fetch confirmed state and older failed status reads are ignored", async () => {
  const f = fixture()
  const old = deferred<void>()
  f.setStatus(async () => {
    await old.promise
    throw new Error("old error")
  })
  const read = f.session.getAccountStatus()
  const login = f.session.beginSignIn()
  await tick()
  await f.session.completeSignIn("bharatcode://auth/callback?state=state-1&code=code")
  const accepted = await login
  old.resolve()
  expect(await read).toEqual(accepted)
  f.setStatus(async () => signedIn)
  expect((await f.session.getAccountStatus()).state).toBe("signed_in")
})

test("failed first logout cannot drop the read barrier for a second queued logout", async () => {
  const firstRemoval = deferred<void>()
  const secondRemoval = deferred<void>()
  const staleRead = deferred<typeof signedIn>()
  const events: Array<{ state: string }> = []
  let removals = 0
  let reads = 0
  const session = createAccountSession({
    client: {
      getAccountStatus: async () => {
        reads++
        return staleRead.promise
      },
      beginSignIn: async () => {
        throw new Error("unused")
      },
      completeSignIn: async () => {
        throw new Error("unused")
      },
      logout: async () => {
        if (++removals === 1) {
          await firstRemoval.promise
          throw new Error("first removal failed")
        }
        await secondRemoval.promise
        return signedOut
      },
    },
    openBrowser: async () => {},
    changed: (status) => events.push(status),
  })
  const first = session.logout().catch((e: Error) => e.message)
  const second = session.logout()
  firstRemoval.resolve()
  expect(await first).toBe("Could not sign out of BharatCode. Try again.")
  const during = session.getAccountStatus()
  await tick()
  const readsWhileRemoving = reads
  secondRemoval.resolve()
  expect((await second).state).toBe("signed_out")
  staleRead.resolve(signedIn)
  const observed = await during
  expect(readsWhileRemoving).toBe(0)
  expect(observed.state).not.toBe("signed_in")
  expect(events.at(-1)?.state).toBe("signed_out")
  expect(events.some((event) => event.state === "signed_in")).toBe(false)
})
