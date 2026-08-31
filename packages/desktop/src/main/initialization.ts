import type { InitStep, ServerReadyData } from "../preload/types"

export async function awaitInitialization(input: {
  current: () => InitStep
  subscribe: (listener: (step: InitStep) => void) => () => void
  server: Promise<ServerReadyData>
  terminal: Promise<void>
  send: (step: InitStep) => void
  signal?: AbortSignal
}) {
  if (input.signal?.aborted) throw new Error("Initialization observer closed")
  let cancel!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error("Initialization observer closed"))
  })
  input.signal?.addEventListener("abort", cancel, { once: true })
  const dispose = input.subscribe(input.send)
  try {
    input.send(input.current())
    const [server] = await Promise.race([Promise.all([input.server, input.terminal]), cancelled])
    return server
  } finally {
    dispose()
    input.signal?.removeEventListener("abort", cancel)
  }
}
