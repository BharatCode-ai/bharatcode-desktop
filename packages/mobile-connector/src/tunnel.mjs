import { OpenTunnelClient, OpenTunnelApiClient, OpenTunnelStorage } from '@opentunnel/client/effect'
import { Effect, Exit, ManagedRuntime, Scope, Stream } from 'effect'
import { mkdir, chmod } from 'node:fs/promises'
import { tunnelOrigin } from './policy.mjs'

export const tunnelAPI = 'https://tunnel.bharatcode.ai'
const profile = 'bharatcode-mobile'

async function runtimeFor(storePath) {
  await mkdir(storePath, { recursive: true, mode: 0o700 })
  await chmod(storePath, 0o700)
  return ManagedRuntime.make(OpenTunnelClient.layer({
    api: tunnelAPI,
    storage: OpenTunnelStorage.xdg({ env: { ...process.env, XDG_DATA_HOME: storePath } }),
  }))
}

// Use the SDK's cancellable Effect interface: certificate issuance may take minutes.
// Only the authenticated gateway is routed; never expose the Desktop sidecar itself.
export async function connectTunnel({ target, storePath, signal, onProgress }) {
  const url = new URL(target)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Gateway must listen on loopback')
  signal?.throwIfAborted()
  const runtime = await runtimeFor(storePath)
  const scope = await runtime.runPromise(Scope.make())
  let connection, closing
  const run = operation => runtime.runPromise(Effect.flatMap(OpenTunnelClient, operation), { signal })
  const close = () => closing ??= (async () => {
    try { if (connection) await runtime.runPromise(connection.close) }
    finally {
      try { await runtime.runPromise(Scope.close(scope, Exit.void)) }
      finally { await runtime.dispose() }
    }
  })()
  try {
    const existing = await run(client => client.tunnel.get({ profile }))
    if (!existing) {
      const pending = await run(client => client.tunnel.pending({ profile }))
      await run(client => pending ? client.tunnel.resume({ profile, onProgress }) : client.tunnel.create({ profile, onProgress }))
    }
    onProgress?.('connecting')
    connection = await run(client => Effect.provideService(client.tunnel.connect({ profile, routes: { '@': `${url.hostname}:${url.port}` } }), Scope.Scope, scope))
    signal?.throwIfAborted()
    const origin = tunnelOrigin(`https://${connection.tunnel.hostname}`)
    const abort = () => { void close().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    return { origin, events: Stream.toAsyncIterable(connection.events), close: async () => { signal?.removeEventListener('abort', abort); await close() } }
  } catch (error) { await close(); throw error }
}

export async function removeTunnel({ storePath }) {
  await mkdir(storePath, { recursive: true, mode: 0o700 })
  await chmod(storePath, 0o700)
  const storage = OpenTunnelStorage.xdg({ env: { ...process.env, XDG_DATA_HOME: storePath } })
  const runtime = ManagedRuntime.make(OpenTunnelApiClient.layer({ api: tunnelAPI }))
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const identity = (yield* storage.load(profile)) ?? (yield* storage.loadPending(profile))
      if (!identity) return
      const api = yield* OpenTunnelApiClient
      const authorized = yield* api.authorized(identity.token)
      // Deletion requires the tunnel token, never a ready certificate.
      yield* authorized.tunnel['tunnel.remove']({ params: { id: identity.id } })
      yield* storage.remove(profile)
    }), { signal: AbortSignal.timeout(30_000) })
  } finally { await runtime.dispose() }
}
