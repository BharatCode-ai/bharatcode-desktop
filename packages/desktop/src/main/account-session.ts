import type { BharatCodeAccountStatus } from "../preload/types"
import type { createBharatCodeAccountClient } from "./bharatcode-auth"
import { isBharatCodeAuthCallback } from "./bharatcode-auth"
import { nativeT } from "./native-translations"

type Client = Pick<
  ReturnType<typeof createBharatCodeAccountClient>,
  "getAccountStatus" | "beginSignIn" | "completeSignIn" | "logout"
>
type Attempt = {
  state?: string
  claimed: boolean
  clear: () => void
  resolve: (value: BharatCodeAccountStatus) => void
  reject: (error: Error) => void
}

// OAuth state, callback URLs and credential transport stay exclusively in main.
// Renderer success means the matching callback finished, never merely browser-open.
export function createAccountSession(options: {
  client: Client
  openBrowser: (url: string) => Promise<unknown>
  changed: (status: BharatCodeAccountStatus) => void
  schedule?: (fn: () => void, milliseconds: number) => () => void
}) {
  let revision = 0
  let generation = 0
  let reads = 0
  let disposed = false
  let removing = 0
  let pending: Attempt | undefined
  let tail = Promise.resolve()
  let latest: BharatCodeAccountStatus = {
    state: "signed_out",
    authenticated: false,
    checkedAt: new Date().toISOString(),
    revision,
  }

  const publish = (status: BharatCodeAccountStatus) => {
    latest = {
      state: status.state,
      authenticated: status.authenticated,
      checkedAt: status.checkedAt,
      revision: ++revision,
      ...(status.email === undefined ? {} : { email: status.email }),
      ...(status.name === undefined ? {} : { name: status.name }),
      ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
      ...(status.message === undefined ? {} : { message: status.message }),
    }
    // A closing renderer cannot turn a committed account transaction into failure.
    try {
      options.changed(latest)
    } catch {
      /* Late subscribers read the snapshot. */
    }
    return latest
  }
  const state = (value: BharatCodeAccountStatus["state"], message?: string) =>
    publish({
      state: value,
      authenticated: false,
      checkedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
    })
  const serial = <T>(run: () => Promise<T>) => {
    const result = tail.then(run)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const cancel = () => {
    generation++
    const attempt = pending
    pending = undefined
    attempt?.clear()
    attempt?.reject(new Error(nativeT("desktop.account.error.cancelled")))
  }
  const fail = (attempt: Attempt, message: string) => {
    if (pending !== attempt) return
    generation++
    pending = undefined
    attempt.clear()
    state("needs_sign_in", message)
    attempt.reject(new Error(message))
  }
  const schedule =
    options.schedule ??
    ((fn, milliseconds) => {
      const timer = setTimeout(fn, milliseconds)
      timer.unref?.()
      return () => clearTimeout(timer)
    })

  const getAccountStatus = async () => {
    if (pending || removing || disposed) return latest
    const epoch = generation
    const read = ++reads
    const next = await options.client.getAccountStatus().catch(() => {
      if (epoch !== generation || read !== reads || disposed) return latest
      throw new Error(nativeT("desktop.account.error.status"))
    })
    if (epoch !== generation || read !== reads || disposed) return latest
    return publish(next)
  }

  const beginSignIn = (input: { selectAccount?: boolean } = {}) => {
    if (disposed) return Promise.reject(new Error(nativeT("desktop.account.error.unavailable")))
    cancel()
    const result = Promise.withResolvers<BharatCodeAccountStatus>()
    const attempt: Attempt = { claimed: false, clear: () => {}, resolve: result.resolve, reject: result.reject }
    pending = attempt
    state(input.selectAccount ? "switching" : "authorizing")
    attempt.clear = schedule(() => fail(attempt, nativeT("desktop.account.error.timeout")), 180_000)
    void serial(async () => {
      if (pending !== attempt) return
      const authorization = await options.client.beginSignIn(input)
      if (pending !== attempt) return
      const url = new URL(authorization.url)
      const values = url.searchParams.getAll("state")
      if (values.length !== 1 || !values[0]) throw new Error("Missing authorization state")
      attempt.state = values[0]
      await options.openBrowser(authorization.url)
    }).catch(() => fail(attempt, nativeT("desktop.account.error.start")))
    return result.promise
  }

  const completeSignIn = (callbackUrl: string) => {
    const attempt = pending
    const url = URL.canParse(callbackUrl) ? new URL(callbackUrl) : undefined
    const states = url?.searchParams.getAll("state")
    if (
      !attempt ||
      attempt.claimed ||
      !isBharatCodeAuthCallback(callbackUrl) ||
      states?.length !== 1 ||
      !attempt.state ||
      states[0] !== attempt.state
    ) {
      return Promise.reject(new Error("BharatCode sign-in callback is no longer active."))
    }
    attempt.claimed = true
    // Once exchange starts, logout waits for it and then removes its credentials.
    // A browser-wait timeout must not abandon a running credential transaction.
    attempt.clear()
    return serial(async () => {
      if (pending !== attempt) throw new Error("BharatCode sign-in was cancelled.")
      let completed = false
      try {
        const next = await options.client.completeSignIn(callbackUrl)
        if (pending !== attempt || disposed) throw new Error("BharatCode sign-in was cancelled.")
        if (next.state !== "signed_in" || !next.authenticated) throw new Error("Sign-in is not confirmed")
        generation++
        pending = undefined
        const status = publish(next)
        completed = true
        attempt.resolve(status)
        return status
      } finally {
        // A cancelled exchange can have committed even when its following status
        // read fails. Clear that late result inside the same mutation queue, before
        // admitting a newer attempt. Explicit logout owns its queued removal.
        if (!completed && pending !== attempt && !removing) await options.client.logout()
      }
    }).catch(() => {
      fail(attempt, nativeT("desktop.account.error.complete"))
      throw new Error(nativeT("desktop.account.error.complete"))
    })
  }

  const logout = () => {
    cancel()
    const epoch = generation
    removing++
    state("refreshing")
    return serial(async () => {
      const next = await options.client.logout()
      if (epoch !== generation || disposed) return latest
      return publish(next)
    })
      .catch(() => {
        if (epoch === generation && !disposed) state("connection_issue", nativeT("desktop.account.error.logout"))
        throw new Error(nativeT("desktop.account.error.logout"))
      })
      .finally(() => {
        // Each queued logout owns its barrier. An earlier failure cannot expose
        // the store while a later removal is still running.
        removing--
        reads++
      })
  }

  return {
    getAccountStatus,
    beginSignIn,
    completeSignIn,
    logout,
    refreshAccountStatus: getAccountStatus,
    dispose: () => {
      disposed = true
      cancel()
    },
    cancelSignIn: () => {
      if (!pending) return
      cancel()
      state("needs_sign_in", nativeT("desktop.account.error.cancelled"))
    },
  }
}
