export function tunnelOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+tunnel\.bharatcode\.ai(?::443)?\/?$/i.test(value)) throw new Error('An HTTPS BharatCode tunnel origin is required')
  const url = new URL(value)
  return url.origin
}

const id = '[A-Za-z0-9_-]+'
const rules = [
  ['GET', /^\/api\/(session|session\/active|model|agent|location)$/, ['limit', 'order', 'cursor', 'search', 'directory', 'project', 'subpath', 'workspace', 'location[directory]', 'location[workspace]']],
  ['POST', /^\/api\/session$/, []],
  ['GET', new RegExp(`^/api/session/${id}$`), []],
  ['GET', new RegExp(`^/api/session/${id}/(message|history|event|permission|question|context|diff)$`), ['limit', 'order', 'cursor', 'after']],
  ['GET', new RegExp(`^/api/session/${id}/message/${id}$`), []],
  ['POST', new RegExp(`^/api/session/${id}/(prompt|interrupt|model|agent)$`), []],
  ['POST', new RegExp(`^/api/session/${id}/(permission|question)/${id}/reply$`), []],
  ['GET', /^\/api\/(permission|question)\/request$/, ['location[directory]', 'location[workspace]']],
]

export function allowed(method, raw) {
  const rawPath = raw.split(/[?#]/, 1)[0]
  if (!raw.startsWith('/') || raw.startsWith('//') || /\\|%(2f|5c|2e|00)/i.test(rawPath) || /%00|\x00/i.test(raw)) return false
  const url = new URL(raw, 'http://localhost')
  return rules.some(([verb, path, keys]) => verb === method && path.test(url.pathname) && [...url.searchParams.keys()].every(key => keys.includes(key)))
}

export function sidecarOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The sidecar must be a loopback HTTP origin')
  return url.origin
}
