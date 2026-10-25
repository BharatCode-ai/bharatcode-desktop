import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export const secret = () => randomBytes(32).toString('base64url')
export const verifier = value => createHash('sha256').update(value).digest('hex')
export function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(verifier(value)), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function openDevices(path) {
  if (!path) throw new Error('Private device store path required')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let state
  try {
    state = JSON.parse(await readFile(path, 'utf8'))
    if (state.version !== 1 || typeof state.desktopID !== 'string' || !Array.isArray(state.devices) || state.devices.some(d => typeof d.id !== 'string' || !/^[a-f0-9]{64}$/.test(d.verifier))) throw new Error('Invalid device registry')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { version: 1, desktopID: 'pc_' + secret().slice(0, 20), devices: [] }
  }
  let writes = Promise.resolve()
  function save(next) {
    const operation = writes.then(async () => {
      const temporary = path + '.' + secret().slice(0, 8)
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
      await rename(temporary, path)
      state = next
    })
    writes = operation.catch(() => {})
    return operation
  }
  // Mutations build their next state only after preceding writes have settled.
  let mutations = Promise.resolve()
  const mutate = fn => {
    const operation = mutations.then(() => save(fn(state)))
    mutations = operation.catch(() => {})
    return operation
  }
  await save(state)
  return {
    get desktopID() { return state.desktopID },
    list: () => state.devices.map(({ verifier: _, ...device }) => ({ ...device })),
    authenticate: token => state.devices.find(device => matches(token, device.verifier)),
    add: device => mutate(current => ({ ...current, devices: [...current.devices, device] })),
    remove: id => mutate(current => ({ ...current, devices: current.devices.filter(d => d.id !== id) })),
  }
}
