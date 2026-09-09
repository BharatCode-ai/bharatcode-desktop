import { expect, test } from "bun:test"
import { createBharatCodeAccountClient } from "./bharatcode-auth"

test("local storage failure keeps account status usable without claiming signed-out or leaking details", async () => {
  const client = createBharatCodeAccountClient({
    getConnection: async () => ({ url: "http://127.0.0.1:3000", username: "bharatcode", password: "synthetic" }),
    fetchImpl: (async () =>
      Response.json({ error: { message: "C:\\private\\auth.json synthetic-token" } }, { status: 503 })) as typeof fetch,
  })
  for (const status of [await client.getAccountStatus(), await client.refreshAccountStatus()]) {
    expect(status.state).toBe("connection_issue")
    expect(status.authenticated).toBe(false)
    expect(status.message).toContain("account storage is unavailable")
    expect(status.message).toContain("retry")
    expect(JSON.stringify(status)).not.toMatch(/private|auth\.json|synthetic-token/)
  }
})

test("storage resilience does not hide unsafe redirects or authorization failures", async () => {
  for (const status of [302, 401, 403]) {
    const client = createBharatCodeAccountClient({
      getConnection: async () => ({ url: "http://127.0.0.1:3000", username: "bharatcode", password: "synthetic" }),
      fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
    })
    await expect(client.getAccountStatus()).rejects.toBeInstanceOf(Error)
  }
})
