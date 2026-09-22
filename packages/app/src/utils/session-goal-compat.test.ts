import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"
import { normalizeSessionInfo } from "./session"

test("retains persisted Goal Mode through V1 list/get/fork and current-session normalization", async () => {
  const session: Session = {
    id: "ses_goal",
    slug: "goal",
    projectID: "project",
    directory: "/repo",
    title: "Goal",
    version: "1",
    time: { created: 1, updated: 2 },
    goal: { text: "Finish the task", status: "paused", created: 1, updated: 2, accumulated: 50 },
  }
  const server = { url: "http://localhost:4096" }
  const fetcher = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return Response.json(url.pathname === "/session" ? [session] : session)
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const api = createCompatibleApi({
    protocol: Promise.resolve("v1"),
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, directory, fetch: fetcher, throwOnError: true }),
  })
  const list = await api.session.list({ directory: "/repo" })
  const get = await api.session.get({ sessionID: session.id })
  const fork = await api.session.fork({ sessionID: session.id })
  for (const result of [list.data[0]!, get, fork]) {
    expect(normalizeSessionInfo(result).goal).toEqual(session.goal)
  }
  delete session.goal
  expect(normalizeSessionInfo(await api.session.get({ sessionID: session.id })).goal).toBeUndefined()
})
