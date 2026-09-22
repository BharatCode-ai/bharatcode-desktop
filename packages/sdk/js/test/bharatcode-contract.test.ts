import { expect, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client"

test("generated SDK sends structural account payloads and Goal Mode updates", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const client = createOpencodeClient({
    baseUrl: "http://fixture.test",
    fetch: (async (input: Request) => {
      calls.push({ path: new URL(input.url).pathname, method: input.method, body: await input.json() })
      return Response.json({})
    }) as typeof fetch,
  })
  await client.v2.account.authorize({
    bharatCodeAuthorizeRequest: { redirectUri: "bharatcode://auth/callback", selectAccount: true },
  })
  await client.v2.account.callback({
    bharatCodeCallbackRequest: { callbackUrl: "bharatcode://auth/callback?synthetic" },
  })
  await client.session.update({ sessionID: "ses_fixture", goal: { action: "set", text: "Synthetic goal" } })
  await client.session.update({ sessionID: "ses_fixture", goal: { action: "pause" } })
  expect(calls).toEqual([
    {
      path: "/account/authorize",
      method: "POST",
      body: { redirectUri: "bharatcode://auth/callback", selectAccount: true },
    },
    { path: "/account/callback", method: "POST", body: { callbackUrl: "bharatcode://auth/callback?synthetic" } },
    { path: "/session/ses_fixture", method: "PATCH", body: { goal: { action: "set", text: "Synthetic goal" } } },
    { path: "/session/ses_fixture", method: "PATCH", body: { goal: { action: "pause" } } },
  ])
})
