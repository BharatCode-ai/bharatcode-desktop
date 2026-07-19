import { open as openDatabase } from "#auth-lock-db"

export interface WaitEvent {
  readonly attempt: number
  readonly delay: number
  readonly waited: number
}

export interface Options {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly onWait?: (event: WaitEvent) => void | Promise<void>
  readonly open?: (file: string) => Database
}

export interface Lease {
  readonly release: () => void
}

export interface Database {
  readonly exec: (sql: string) => void
  readonly close: () => void
}

const defaults = {
  timeoutMs: 5 * 60_000,
  baseDelayMs: 10,
  maxDelayMs: 250,
}

export async function acquire(file: string, options: Options = {}): Promise<Lease> {
  options.signal?.throwIfAborted()
  const database = (options.open ?? openDatabase)(file)
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs
  const baseDelayMs = options.baseDelayMs ?? defaults.baseDelayMs
  const maxDelayMs = options.maxDelayMs ?? defaults.maxDelayMs
  const started = performance.now()
  let attempt = 0
  let waited = 0
  let delay = baseDelayMs
  let acquired = false
  let closed = false

  const close = () => {
    if (closed) return
    database.close()
    closed = true
  }

  const release = () => {
    let failure: unknown
    if (acquired) {
      try {
        database.exec("ROLLBACK")
        acquired = false
      } catch (error) {
        failure = error
      }
    }
    if (!closed) {
      try {
        close()
        // Closing a SQLite connection rolls back any still-active transaction.
        acquired = false
      } catch (error) {
        failure ??= error
      }
    }
    if (!closed) throw failure
  }

  try {
    while (true) {
      options.signal?.throwIfAborted()
      try {
        database.exec("BEGIN IMMEDIATE")
        acquired = true
        if (options.signal?.aborted) {
          const reason = options.signal.reason
          release()
          throw reason ?? new DOMException("The operation was aborted", "AbortError")
        }
        return { release }
      } catch (error) {
        if (!isBusy(error)) throw error
      }

      if (performance.now() - started >= timeoutMs) throw new Error("Credential store lock timed out.")
      attempt += 1
      const current = Math.min(delay, Math.max(0, timeoutMs - (performance.now() - started)))
      await options.onWait?.({ attempt, delay: current, waited })
      await sleep(current, options.signal)
      waited += current
      delay = Math.min(maxDelayMs, Math.max(baseDelayMs, Math.floor(delay * 1.7)))
    }
  } catch (error) {
    if (acquired) {
      try {
        release()
      } catch {
        // Preserve the acquisition failure; the Auth boundary redacts native causes.
      }
    } else if (!closed) {
      try {
        close()
      } catch {
        // The Auth boundary replaces native acquisition failures with a static typed error.
      }
    }
    throw error
  }
}

export function isBusy(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const value = error as { readonly code?: unknown; readonly errno?: unknown; readonly errcode?: unknown }
  return (
    sqliteBase(value.errno) === 5 ||
    sqliteBase(value.errcode) === 5 ||
    value.code === "SQLITE_BUSY" ||
    (typeof value.code === "string" && value.code.startsWith("SQLITE_BUSY_"))
  )
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    function done() {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }

    function aborted() {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }

    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted) {
      aborted()
      return
    }
    timer = setTimeout(done, ms)
  })
}

function sqliteBase(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value & 0xff : undefined
}

export * as AuthLock from "./lock"
