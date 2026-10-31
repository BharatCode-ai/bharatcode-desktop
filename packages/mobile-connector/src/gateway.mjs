import { createServer, request as httpRequest } from 'node:http'
import { hostname, platform } from 'node:os'
import { randomInt } from 'node:crypto'
import { once } from 'node:events'
import { projectEvents } from './live.mjs'
import { projectFile } from './files.mjs'
import { createDesktopAPI } from './desktop-api.mjs'
import { join, dirname } from 'node:path'
import { openDevices, secret, verifier, matches } from './devices.mjs'
import { allowed, sidecarOrigin, tunnelOrigin } from './policy.mjs'

const lifetime = 300_000
const maxBody = 1_048_576

export async function createGateway(options) {
  const registry = await openDevices(options.storePath)
  const upstream = sidecarOrigin(options.upstream)
  if (!options.password) throw new Error('Sidecar password required')
  const now = options.now ?? Date.now
  const claims = new Map(), active = new Map()
  const desktopAPI = options.runtime === 'desktop' ? await createDesktopAPI({ request: upstreamCall, storePath: join(dirname(options.storePath), 'admissions.json') }) : undefined
  let qr, closed = false, attempts = []
  const metadata = () => ({ id: registry.desktopID, name: options.name ?? hostname(), platform: platform() })
  function issuePairing(origin) {
    if (closed) throw new Error('Gateway closed')
    claims.clear()
    qr = { v: 1, desktopID: registry.desktopID, origin: tunnelOrigin(origin), code: secret(), expiresAt: now() + lifetime }
    return { ...qr }
  }
  function claimFor(body) {
    const claim = claims.get(body.claimID)
    if (!claim || !matches(body.claimSecret, claim.verifier)) throw status(401, 'Invalid pairing claim')
    if (claim.expiresAt <= now()) { claims.delete(body.claimID); throw status(410, 'Pairing expired') }
    if (claim.state === 'consumed') throw status(410, 'Pairing already consumed')
    return claim
  }
  async function approve(id) {
    const claim = claims.get(id)
    if (!claim || claim.state !== 'waiting' || claim.expiresAt <= now()) throw new Error('Pairing expired or already resolved')
    // Reserve synchronously before the first await: approval cannot issue twice.
    claim.state = 'approving'
    const token = secret()
    const device = { id: 'dev_' + secret().slice(0, 20), name: claim.name, pairedAt: now(), verifier: verifier(token) }
    try { await registry.add(device) } catch (error) { claim.state = 'waiting'; throw error }
    qr = undefined
    for (const other of claims.values()) if (other !== claim && other.state === 'waiting') other.state = 'declined'
    claim.state = 'approved'
    claim.token = token
    claim.device = { id: device.id, name: device.name, pairedAt: device.pairedAt }
  }
  function decline(id) {
    const claim = claims.get(id)
    if (claim?.state === 'waiting') claim.state = 'declined'
  }
  async function revoke(id) {
    await registry.remove(id)
    for (const abort of active.get(id) ?? []) abort()
    active.delete(id)
  }
  async function handle(req, res) {
    try {
      if (req.headers.origin) throw status(403, 'Browser-origin requests are not allowed')
      if (req.method === 'POST' && req.url === '/mobile/v1/claim') {
        const body = await jsonBody(req)
        if (!qr || qr.expiresAt <= now() || (body.code !== undefined ? !matches(body.code, verifier(qr.code)) : body.desktopID !== registry.desktopID)) throw status(401, 'Pairing code expired or used')
        if (typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(body.deviceName)) throw status(400, 'Invalid device name')
        for (const [id, claim] of claims) if (claim.expiresAt <= now()) claims.delete(id)
        attempts = attempts.filter(time => now() - time < 60_000)
        if (claims.size >= 5 || attempts.length >= 10) throw status(429, 'Too many pairing attempts; refresh on Desktop')
        attempts.push(now())
        // A public link is discovery only. Access is issued solely by Desktop approval.
        if (body.code !== undefined) qr = undefined
        const claimID = secret(), claimSecret = secret(), confirmation = String(randomInt(1_000_000)).padStart(6, '0')
        const claim = { claimID, verifier: verifier(claimSecret), name: body.deviceName.trim(), confirmation, expiresAt: now() + lifetime, state: 'waiting' }
        claims.set(claimID, claim)
        options.onPairingRequest?.({ claimID, name: claim.name, confirmation, expiresAt: claim.expiresAt })
        return reply(res, 201, { claimID, claimSecret, confirmation, expiresAt: claim.expiresAt })
      }
      if (req.method === 'POST' && req.url === '/mobile/v1/claim/status') {
        const body = await jsonBody(req), claim = claimFor(body)
        if (claim.state === 'approved') {
          const result = { state: 'approved', token: claim.token, device: claim.device, desktop: metadata() }
          claim.state = 'consumed'
          delete claim.token
          return reply(res, 200, result)
        }
        return reply(res, 200, { state: claim.state })
      }
      const bearer = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization ?? '')?.[1]
      const device = bearer && registry.authenticate(bearer)
      if (!device) throw status(401, 'Device authorization required')
      if (req.method === 'GET' && req.url === '/mobile/v1/health') return reply(res, 200, {
        protocol: 1, desktop: metadata(), capabilities: { sessions: true, prompts: true, replay: options.runtime !== 'desktop', permissions: true, questions: true, models: true, live: true, changes: true, files: true, terminal: false },
      })
      if (req.method === 'DELETE' && req.url === '/mobile/v1/device') {
        await revoke(device.id)
        return reply(res, 200, { revoked: true })
      }
      const cancellation = new AbortController()
      const abortIncoming = () => { cancellation.abort(); req.destroy(); res.destroy() }
      if (!active.has(device.id)) active.set(device.id, new Set())
      active.get(device.id).add(abortIncoming)
      res.once('close', () => { cancellation.abort(); active.get(device.id)?.delete(abortIncoming); if (!active.get(device.id)?.size) active.delete(device.id) })
      const live = /^\/mobile\/v1\/session\/([A-Za-z0-9_-]+)\/live$/.exec(req.url)
      if (req.method === 'GET' && live) {
        let directory
        if (options.runtime === 'desktop') {
          const session = await upstreamJSON('/session/' + live[1], cancellation.signal)
          if (typeof session?.directory !== 'string') throw status(502, 'Desktop session location unavailable')
          directory = session.directory
        }
        const eventPath = (options.runtime === 'desktop' ? '/event' : '/api/event') + (directory === undefined ? '' : '?' + new URLSearchParams({ directory }))
        const response = await fetch(upstream + eventPath, {
          headers: { authorization: 'Basic ' + Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64'), accept: 'text/event-stream' },
          redirect: 'error', signal: cancellation.signal,
        })
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel(); throw status(502, 'Live events unavailable')
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.write(': connected\n\n')
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 10_000)
        try {
          for await (const event of projectEvents(response.body, live[1], { desktop: options.runtime === 'desktop', resolveMessage: async id => {
            if (!/^[A-Za-z0-9_-]+$/.test(id)) return
            return upstreamJSON(`/session/${live[1]}/message/${id}?` + new URLSearchParams({ directory }), cancellation.signal)
          } })) {
            if (!registry.authenticate(bearer)) break
            if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: cancellation.signal })
          }
        } finally { clearInterval(heartbeat); await response.body?.cancel().catch(() => {}); res.end() }
        return
      }
      const fileURL = new URL(req.url, 'http://localhost')
      const files = /^\/mobile\/v1\/session\/([A-Za-z0-9_-]+)\/files$/.exec(fileURL.pathname)
      if (req.method === 'GET' && files) {
        if ([...fileURL.searchParams.keys()].some(key => key !== 'path') || fileURL.searchParams.getAll('path').length > 1) throw status(400, 'Invalid file query')
        const session = await upstreamJSON(`/api/session/${files[1]}`, cancellation.signal)
        const directory = session.data?.location?.directory
        if (typeof directory !== 'string') throw status(502, 'Session location unavailable')
        const data = await projectFile(directory, fileURL.searchParams.get('path') ?? '')
        if (!registry.authenticate(bearer)) throw status(401, 'Device authorization revoked')
        return reply(res, 200, { data })
      }
      const changes = /^\/mobile\/v1\/session\/([A-Za-z0-9_-]+)\/changes$/.exec(req.url)
      if (req.method === 'GET' && changes) {
        const session = await upstreamJSON(`/api/session/${changes[1]}`, cancellation.signal)
        const directory = session.data?.location?.directory
        if (typeof directory !== 'string') throw status(502, 'Session location unavailable')
        const query = new URLSearchParams({ directory, mode: 'git', context: '3' })
        const data = await upstreamJSON('/vcs/diff?' + query, cancellation.signal)
        if (!registry.authenticate(bearer)) throw status(401, 'Device authorization revoked')
        return reply(res, 200, { data: Array.isArray(data) ? data : [] })
      }
      if (!allowed(req.method, req.url)) throw status(403, 'Route is not available to mobile devices')
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await rawBody(req) : undefined
      if (!registry.authenticate(bearer)) throw status(401, 'Device authorization revoked')
      if (body?.length && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw status(415, 'JSON required')
      if (desktopAPI) {
        const result = await desktopAPI.handle(req.method, req.url, body?.length ? JSON.parse(body.toString()) : undefined, cancellation.signal)
        if (result) {
          if (!registry.authenticate(bearer)) throw status(401, 'Device authorization revoked')
          return reply(res, result.status ?? 200, result.data)
        }
      }
      forward(req, res, device.id, body)
    } catch (error) {
      if (!res.headersSent) reply(res, error.status ?? 500, { error: error.status ? error.message : 'Connection request failed' })
      else res.destroy()
    }
  }
  async function upstreamCall(path, method = 'GET', body, signal) {
    const response = await fetch(upstream + path, {
      method, headers: {
        authorization: 'Basic ' + Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64'),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    })
    if (!response.ok) { await response.body?.cancel(); throw status(response.status, 'Computer could not complete the request') }
    if (!response.body) return { data: undefined, cursor: response.headers.get('x-next-cursor') ?? undefined }
    const chunks = []; let size = 0
    for await (const chunk of response.body) { size += chunk.length; if (size > 16_777_216) throw status(413, 'Computer response is too large'); chunks.push(chunk) }
    const text = Buffer.concat(chunks).toString()
    return { data: text ? JSON.parse(text) : undefined, cursor: response.headers.get('x-next-cursor') ?? undefined }
  }
  async function upstreamJSON(path, signal) { return (await upstreamCall(path, 'GET', undefined, signal)).data }
  function forward(req, res, deviceID, body) {
    const target = new URL(req.url, upstream)
    const headers = { authorization: 'Basic ' + Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64'), accept: req.headers.accept ?? 'application/json' }
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length }
    const remote = httpRequest(target, { method: req.method, headers }, incoming => {
      if (incoming.statusCode >= 300 && incoming.statusCode < 400) { incoming.destroy(); reply(res, 502, { error: 'Unexpected sidecar redirect' }); return }
      const contentType = incoming.headers['content-type'] ?? 'application/json'
      if (target.pathname === '/api/model' || target.pathname === '/api/agent') {
        const chunks = []; let length = 0
        incoming.on('data', chunk => { length += chunk.length; if (length > maxBody) { incoming.destroy(); reply(res, 502, { error: 'Metadata exceeds supported size' }); return } chunks.push(chunk) })
        incoming.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString())
            if (!Array.isArray(result.data)) throw new Error('Invalid metadata')
            const fields = target.pathname === '/api/model' ? ['id', 'providerID', 'name', 'enabled'] : ['id', 'name', 'description', 'mode']
            const data = result.data.map(item => Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])))
            reply(res, incoming.statusCode ?? 502, { data })
          } catch { reply(res, 502, { error: 'Invalid Desktop metadata' }) }
        })
        incoming.on('error', () => { if (!res.headersSent) reply(res, 502, { error: 'Desktop metadata unavailable' }) })
        return
      }
      res.writeHead(incoming.statusCode ?? 502, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      let size = 0
      incoming.on('data', chunk => {
        if (!contentType.includes('text/event-stream') && (size += chunk.length) > 16_777_216) { incoming.destroy(); res.destroy() }
      })
      incoming.on('error', () => res.destroy())
      incoming.pipe(res)
    })
    const abort = () => { remote.destroy(); res.destroy() }
    if (!active.has(deviceID)) active.set(deviceID, new Set())
    active.get(deviceID).add(abort)
    remote.on('error', () => { if (!res.headersSent && !res.destroyed) reply(res, 502, { error: 'Computer server unavailable' }); else res.destroy() })
    remote.setTimeout(30_000, () => remote.destroy())
    res.once('close', () => { remote.destroy(); active.get(deviceID)?.delete(abort); if (!active.get(deviceID)?.size) active.delete(deviceID) })
    remote.end(body)
  }
  const server = createServer((req, res) => void handle(req, res))
  server.requestTimeout = 15_000
  return {
    issuePairing, approve, decline, revoke,
    devices: registry.list,
    async listen() {
      if (closed) throw new Error('Gateway closed')
      if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      closed = true; qr = undefined; claims.clear()
      for (const connections of active.values()) for (const abort of connections) abort()
      active.clear()
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function status(code, message) { return Object.assign(new Error(message), { status: code }) }
function reply(res, code, data) {
  if (res.destroyed || res.headersSent) return
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}
async function rawBody(req) {
  if (Number(req.headers['content-length']) > maxBody) throw status(413, 'Request is too large')
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBody) throw status(413, 'Request is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw status(415, 'JSON required')
  try { const body = JSON.parse((await rawBody(req)).toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body } catch (error) { if (error.status) throw error; throw status(400, 'Invalid JSON') }
}
