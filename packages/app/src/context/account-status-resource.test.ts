import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { isServer } from "solid-js/web"
import { createAccountStatusResource } from "./account-status"
import type { BharatCodeAccountStatus } from "./platform"

if (isServer)
  test("account resources execute against Solid's browser implementation", async () => {
    const child = Bun.spawn([process.execPath, "--conditions=browser", "test", import.meta.path], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, failure: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, failure: "" })
  })
else
  test("two mounted resources share callback events, ignore old initial reads and unsubscribe on disposal", async () => {
    const listeners = new Set<(status: BharatCodeAccountStatus) => void>()
    const reads: Array<(status: BharatCodeAccountStatus) => void> = []
    const platform = {
      getAccountStatus: () => new Promise<BharatCodeAccountStatus>((resolve) => reads.push(resolve)),
      onAccountStatusChanged: (cb: (status: BharatCodeAccountStatus) => void) => {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
    }
    const owners = [0, 1].map(() =>
      createRoot((dispose) => ({ result: createAccountStatusResource(platform), dispose })),
    )
    await Promise.resolve()
    const signedIn: BharatCodeAccountStatus = { revision: 3, state: "signed_in", authenticated: true, checkedAt: "now" }
    for (const listener of listeners) listener(signedIn)
    expect(reads).toHaveLength(2)
    for (const resolve of reads)
      resolve({ revision: 1, state: "signed_out", authenticated: false, checkedAt: "before" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const owner of owners) {
      expect(owner.result[0]()).toEqual(signedIn)
      owner.dispose()
    }
    expect(listeners.size).toBe(0)
  })
