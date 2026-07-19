import { Buffer } from "node:buffer"

export type SidecarAuthorizationPolicy = ReturnType<typeof createSidecarAuthorizationPolicy>

export function createSidecarAuthorizationPolicy(input: { origin: string; username: string; password: string }) {
  const origin = requireExactLoopbackOrigin(input.origin)
  const authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`
  let active = true
  const requests = new Map<number, { startedAtSidecar: boolean; lastAtSidecar: boolean; blocked: boolean }>()

  const strip = (headers: Headers) => {
    const result = new Headers(headers)
    result.delete("authorization")
    return result
  }
  const exactTarget = (target: string) => {
    const url = parseUrl(target)
    return Boolean(url && url.origin === origin && !url.username && !url.password)
  }

  return {
    origin,
    authorize(target: string, headers: Headers) {
      const result = strip(headers)
      if (!active || !exactTarget(target)) return result
      result.set("authorization", authorization)
      return result
    },
    authorizeRedirect(_from: string, _to: string, headers: Headers) {
      const result = strip(headers)
      return result
    },
    beforeRequest(details: { id: number; url: string; resourceType: string; webContentsId?: number }, owner: number) {
      const atSidecar = exactTarget(details.url)
      const sidecarOrigin = parseUrl(details.url)?.origin === origin
      const state = requests.get(details.id)
      if (state?.blocked) return { cancel: true as const }
      if (state && atSidecar !== state.lastAtSidecar && (atSidecar || state.startedAtSidecar)) {
        state.blocked = true
        return { cancel: true as const }
      }
      if (sidecarOrigin && !atSidecar) return { cancel: true as const }
      if (
        atSidecar &&
        (!active || details.webContentsId !== owner || !["xhr", "webSocket"].includes(details.resourceType))
      ) {
        return { cancel: true as const }
      }
      if (!state) requests.set(details.id, { startedAtSidecar: atSidecar, lastAtSidecar: atSidecar, blocked: false })
      else state.lastAtSidecar = atSidecar
      return { cancel: false as const }
    },
    beforeSendHeaders(
      details: {
        id: number
        url: string
        resourceType: string
        webContentsId?: number
        requestHeaders: Record<string, string>
      },
      owner: number,
    ) {
      const state = requests.get(details.id)
      const atSidecar = exactTarget(details.url)
      if (!atSidecar) return { cancel: false as const, requestHeaders: details.requestHeaders }
      const headers = Object.fromEntries(
        Object.entries(details.requestHeaders).filter(([key]) => key.toLowerCase() !== "authorization"),
      )
      if (
        !active ||
        !state?.startedAtSidecar ||
        state.blocked ||
        details.webContentsId !== owner ||
        !["xhr", "webSocket"].includes(details.resourceType)
      ) {
        return { cancel: true as const, requestHeaders: headers }
      }
      return { cancel: false as const, requestHeaders: { ...headers, Authorization: authorization } }
    },
    beforeRedirect(details: { id: number; redirectURL: string }) {
      const state = requests.get(details.id)
      if (!state) return
      if (state.startedAtSidecar || exactTarget(details.redirectURL)) state.blocked = true
    },
    complete(id: number) {
      requests.delete(id)
    },
    invalidate() {
      active = false
      for (const state of requests.values()) state.blocked = true
    },
  }
}

export function requireExactLoopbackOrigin(input: string) {
  const url = parseUrl(input)
  if (
    !url ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("BharatCode sidecar authorization requires an exact loopback origin.")
  }
  return url.origin
}

function parseUrl(input: string) {
  try {
    return new URL(input)
  } catch {
    return undefined
  }
}
