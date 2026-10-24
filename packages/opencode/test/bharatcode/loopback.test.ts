import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { BharatCodeAccount } from "../../src/bharatcode/account"
import { BharatCodeLoopback } from "../../src/bharatcode/loopback"

test("an occupied CLI callback port fails clearly without replacing its listener; retry succeeds after release", async () => {
  const redirect = new URL(BharatCodeAccount.CLI_REDIRECT_URI)
  const occupied = createServer((_request, response) => response.end("test listener remains active"))
  // Bind our own listener or fail. Never stop an unrelated process on this port.
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject)
    occupied.listen(Number(redirect.port), redirect.hostname, resolve)
  })
  try {
    await expect(
      BharatCodeLoopback.start({ expectedState: "synthetic-private-state", timeoutMs: 1000 }),
    ).rejects.toThrow(
      "BharatCode sign-in is already running in another CLI process. Finish or close it, then try again.",
    )
    expect(occupied.listening).toBe(true)
    expect(await fetch(redirect, { signal: AbortSignal.timeout(1000) }).then((response) => response.text())).toBe(
      "test listener remains active",
    )
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())))
  }

  const session = await BharatCodeLoopback.start({ expectedState: "synthetic-retry-state", timeoutMs: 1000 })
  void session.callback.catch(() => undefined)
  try {
    redirect.search = new URLSearchParams({ code: "synthetic-code", state: "synthetic-retry-state" }).toString()
    const response = await fetch(redirect, { signal: AbortSignal.timeout(1000) })
    expect(response.status).toBe(200)
    await response.text()
    expect(await session.callback).toBe(redirect.toString())
  } finally {
    session.close()
  }
})
