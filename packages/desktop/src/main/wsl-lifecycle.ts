import type { WslConfigurationUpdate, WslErrorCode, WslSnapshot, WslStatus } from "./wsl-contract"

export type WslOwnedRuntime = {
  exited: Promise<void>
  stop: () => Promise<void>
  closeInput: () => void
}

export class WslLifecycleFailure extends Error {
  constructor(
    readonly code: WslErrorCode,
    readonly options: { reconnectable?: boolean } = {},
  ) {
    super(code)
    this.name = "WslLifecycleFailure"
  }
}

export function retainWslAuthorizationWhileRunning<T extends { invalidate: () => void }>(
  status: WslStatus,
  authorization: T | undefined,
) {
  if (status.phase === "running") return authorization
  authorization?.invalidate()
  return undefined
}

export async function configureWslForControlledRelaunch(
  update: WslConfigurationUpdate,
  options: {
    snapshot: () => Promise<WslSnapshot>
    configure: (update: WslConfigurationUpdate) => Promise<WslSnapshot>
    relaunch: () => Promise<void>
  },
) {
  const before = await options.snapshot()
  const configured = await options.configure(update)
  if (configured.revision === before.revision) return configured
  const handover: WslSnapshot = {
    ...before,
    revision: configured.revision,
    status: { phase: "starting" },
  }
  await options.relaunch()
  return handover
}

export function classifyWslLaunchFailure(error: unknown) {
  if (error instanceof WslLifecycleFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/non-root|root UID/iu.test(message)) return new WslLifecycleFailure("root-user")
  if (/wslpath|round trip/iu.test(message)) return new WslLifecycleFailure("path-translation")
  if (/manifest|artifact|digest|sha-?256|runtime integrity|immutable/iu.test(message)) {
    return new WslLifecycleFailure("runtime-integrity")
  }
  if (
    /prerequisite|ENOENT.*(?:\/usr\/bin|wsl\.exe)|(?:\/usr\/bin|wsl\.exe).*ENOENT|\/usr\/bin\/(?:id|getent|env|install|sha256sum|stat|findmnt)/iu.test(
      message,
    )
  ) {
    return new WslLifecycleFailure("prerequisite-missing")
  }
  if (/exited before ready|stdout ended|connection lost/iu.test(message)) {
    return new WslLifecycleFailure("connection-lost", { reconnectable: true })
  }
  return new WslLifecycleFailure("start-failed")
}

export function createWslLifecycle(options: {
  revalidate: () => Promise<void>
  startOwned: () => Promise<WslOwnedRuntime>
  delay?: (milliseconds: number) => Promise<void>
  onStatus?: (status: WslStatus) => void
}) {
  let currentStatus: WslStatus = { phase: "ready" }
  let current:
    | {
        runtime: WslOwnedRuntime
        generation: number
        expectedExit: boolean
      }
    | undefined
  let generation = 0
  let reconnectUsed = false
  let operationTail: Promise<void> = Promise.resolve()
  let stopping: Promise<void> | undefined

  const setStatus = (status: WslStatus) => {
    currentStatus = status
    options.onStatus?.(status)
  }

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = operationTail.then(operation, operation)
    operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const reconnect = async () => {
    if (reconnectUsed) {
      setStatus({ phase: "error", code: "connection-lost" })
      return
    }
    reconnectUsed = true
    setStatus({ phase: "starting" })
    await (options.delay ?? defaultDelay)(250)
    await startAttempt(false)
  }

  const watch = (owned: NonNullable<typeof current>) => {
    const recover = () => {
      if (!current || current.generation !== owned.generation || owned.expectedExit) return
      setStatus({ phase: "starting" })
      void serialize(async () => {
        if (!current || current.generation !== owned.generation || owned.expectedExit) return
        current = undefined
        await reconnect()
      }).catch(() => undefined)
    }
    void owned.runtime.exited.then(
      () => recover(),
      () => recover(),
    )
  }

  const startAttempt = async (allowReconnect: boolean): Promise<void> => {
    setStatus({ phase: "starting" })
    try {
      await options.revalidate()
      const runtime = await options.startOwned()
      const owned = { runtime, generation: ++generation, expectedExit: false }
      current = owned
      watch(owned)
      setStatus({ phase: "running" })
    } catch (error) {
      const failure = lifecycleFailure(error, "start-failed")
      if (allowReconnect && failure.options.reconnectable && !reconnectUsed) {
        await reconnect()
        return
      }
      setStatus({ phase: "error", code: failure.code })
      throw failure
    }
  }

  const stopCurrent = async () => {
    if (!current) {
      setStatus({ phase: "ready" })
      return
    }
    const owned = current
    owned.expectedExit = true
    setStatus({ phase: "starting" })
    try {
      await Promise.all([owned.runtime.stop(), owned.runtime.exited])
      if (current?.generation === owned.generation) current = undefined
      setStatus({ phase: "ready" })
    } catch {
      setStatus({ phase: "error", code: "stop-failed" })
      throw new WslLifecycleFailure("stop-failed")
    }
  }

  return {
    status: () => currentStatus,
    projectSnapshot(snapshot: WslSnapshot): WslSnapshot {
      if (!snapshot.enabled || snapshot.status.phase === "error" || currentStatus.phase === "ready") return snapshot
      return { ...snapshot, status: currentStatus }
    },
    start: () => serialize(() => startAttempt(true)),
    stop() {
      if (stopping) return stopping
      if (current) setStatus({ phase: "starting" })
      const result = serialize(stopCurrent)
      stopping = result.finally(() => {
        stopping = undefined
      })
      return stopping
    },
    restart: () => {
      if (current) setStatus({ phase: "starting" })
      return serialize(async () => {
        await stopCurrent()
        await startAttempt(true)
      })
    },
    retry: () => {
      if (current) setStatus({ phase: "starting" })
      return serialize(async () => {
        if (current) await stopCurrent()
        await startAttempt(true)
      })
    },
    closeInput() {
      if (!current) return
      current.expectedExit = true
      current.runtime.closeInput()
    },
    translateProjectPaths: (paths: readonly string[], translate: (path: string) => Promise<string>) =>
      serialize(async () => {
        try {
          await options.revalidate()
          return await Promise.all(paths.map((path) => translate(path)))
        } catch (error) {
          const failure = error instanceof WslLifecycleFailure ? error : new WslLifecycleFailure("path-translation")
          setStatus({ phase: "error", code: failure.code })
          throw failure
        }
      }),
  }
}

export async function rewriteWslProjectDeepLinks(
  values: readonly string[],
  translate: (paths: readonly string[]) => Promise<readonly string[]>,
) {
  const parsed = values.map((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return { value }
    }
    if (
      (url.protocol !== "bharatcode:" && url.protocol !== "opencode:") ||
      (url.hostname !== "open-project" && url.hostname !== "new-session")
    ) {
      return { value }
    }
    const directory = url.searchParams.get("directory")
    if (!directory) return { value }
    return { value, url, directory }
  })
  const targets = parsed.flatMap((item) => (item.directory ? [item.directory] : []))
  if (targets.length === 0) return [...values]
  const translated = await translate(targets)
  if (translated.length !== targets.length) throw new WslLifecycleFailure("path-translation")
  let index = 0
  return parsed.map((item) => {
    if (!item.url) return item.value
    item.url.searchParams.set("directory", translated[index++])
    return item.url.toString()
  })
}

function lifecycleFailure(error: unknown, fallback: WslErrorCode) {
  if (error instanceof WslLifecycleFailure) return error
  return new WslLifecycleFailure(fallback)
}

function defaultDelay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
