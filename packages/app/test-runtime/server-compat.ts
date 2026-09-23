import assert from "node:assert/strict"
import { createApiForServer, createSdkForServer } from "../src/utils/server"
import { createCompatibleApi } from "../src/utils/server-compat"
import { detectServerProtocol } from "../src/utils/server-protocol"

// The real renderer SDKs/adapters, called against an isolated compiled sidecar.
// No provider prompt, OAuth flow or model endpoint is invoked.
export async function verify(input: { url: string; directory: string; sessionID?: string }) {
  const server = { url: input.url, username: "opencode", password: "synthetic-smoke-only" }
  const protocol = detectServerProtocol(server, fetch)
  assert.equal(await protocol, "v1")
  const current = createApiForServer({ server })
  assert.equal((await current.health.get()).healthy, true)
  const api = createCompatibleApi({
    protocol,
    current,
    directory: input.directory,
    legacy: (directory) => createSdkForServer({ server, directory: directory ?? input.directory, throwOnError: true }),
  })
  const project = await api.project.current({ location: { directory: input.directory } })
  assert.equal(project.directory, input.directory)
  const session = input.sessionID
    ? await api.session.get({ sessionID: input.sessionID })
    : await api.session.create({ location: { directory: input.directory } })
  assert.equal(session.location.directory, input.directory)
  if (!input.sessionID)
    await api.session.rename({ sessionID: session.id, title: "Persisted SDK fixture", directory: input.directory })
  const reread = await api.session.get({ sessionID: session.id })
  assert.equal(reread.title, "Persisted SDK fixture")
  assert.equal(reread.location.directory, input.directory)
  const list = await api.session.list({ directory: input.directory })
  assert.equal(
    list.data.some((entry) => entry.id === session.id && entry.title === reread.title),
    true,
  )
  const files = await api.file.list({ location: { directory: input.directory }, path: "" })
  assert.equal(
    files.data.some((entry) => entry.path === "README.md" && entry.type === "file"),
    true,
  )
  const changes = await api.vcs.status({ location: { directory: input.directory } })
  assert.equal(
    changes.data.some((entry) => entry.file === "README.md" && entry.status === "added"),
    true,
  )
  assert.equal(
    Array.isArray(await api.project.directories({ projectID: project.id, location: { directory: input.directory } })),
    true,
  )
  const deniedServer = { ...server, password: "wrong-synthetic-secret" }
  const denied = createCompatibleApi({
    protocol: Promise.resolve("v1"),
    current: createApiForServer({ server: deniedServer }),
    legacy: (directory) =>
      createSdkForServer({ server: deniedServer, directory: directory ?? input.directory, throwOnError: true }),
    directory: input.directory,
  })
  await assert.rejects(() => denied.session.list({ directory: input.directory }))
  if (input.sessionID) {
    await api.session.remove({ sessionID: session.id, directory: input.directory })
    await assert.rejects(() => api.session.get({ sessionID: session.id }))
  }
  return { sessionID: session.id }
}
