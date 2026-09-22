import {
  createSidecarAuthorizationPolicy,
  requireExactLoopbackOrigin,
  type SidecarAuthorizationPolicy,
} from "./sidecar-auth"

type Request = Parameters<SidecarAuthorizationPolicy["beforeRequest"]>[0]
type HeadersRequest = Parameters<SidecarAuthorizationPolicy["beforeSendHeaders"]>[0]

// Each request remains bound to the runtime that owned its first hop, including
// when that runtime is stopped or replaced while the request is outstanding.
export function createSidecarAuthorizations() {
  const policies = new Map<string, SidecarAuthorizationPolicy>()
  const knownOrigins = new Set<string>()
  const requests = new Map<number, { policy?: SidecarAuthorizationPolicy; blocked: boolean }>()
  const find = (url: string) => [...policies.values()].find((policy) => policy.origin === origin(url))
  const known = (url: string) => knownOrigins.has(origin(url) ?? "")

  return {
    set(id: string, connection?: { url: string; username: string; password: string }) {
      const target = connection && requireExactLoopbackOrigin(connection.url)
      if (target && [...policies].some(([key, policy]) => key !== id && policy.origin === target)) {
        throw new Error("Sidecar origin already belongs to another runtime")
      }
      policies.get(id)?.invalidate()
      policies.delete(id)
      if (!connection) return
      const policy = createSidecarAuthorizationPolicy({ ...connection, origin: connection.url })
      knownOrigins.add(policy.origin)
      policies.set(id, policy)
    },
    beforeRequest(details: Request, owner: number) {
      const previous = requests.get(details.id)
      const binding = previous ?? { policy: find(details.url), blocked: false }
      if (!previous) requests.set(details.id, binding)
      if (binding.blocked) return { cancel: true }
      if (binding.policy) {
        const result = binding.policy.beforeRequest(details, owner)
        if (result.cancel || origin(details.url) !== binding.policy.origin) binding.blocked = true
      } else if (known(details.url)) binding.blocked = true
      return { cancel: binding.blocked }
    },
    beforeSendHeaders(details: HeadersRequest, owner: number) {
      const binding = requests.get(details.id)
      if (binding?.blocked || (binding?.policy && origin(details.url) !== binding.policy.origin)) {
        return { cancel: true, requestHeaders: withoutAuthorization(details.requestHeaders) }
      }
      if (binding?.policy) return binding.policy.beforeSendHeaders(details, owner)
      if (known(details.url)) return { cancel: true, requestHeaders: withoutAuthorization(details.requestHeaders) }
      return { cancel: false, requestHeaders: details.requestHeaders }
    },
    beforeRedirect(details: { id: number; redirectURL: string }) {
      const binding = requests.get(details.id)
      if (!binding) return
      // Never carry main-owned credentials through any redirect, including a
      // redirect between two legitimate local runtimes.
      if (binding.policy || known(details.redirectURL)) binding.blocked = true
      binding.policy?.beforeRedirect(details)
    },
    complete(id: number) {
      requests.get(id)?.policy?.complete(id)
      requests.delete(id)
    },
  }
}

function origin(value: string) {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function withoutAuthorization(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization"))
}
