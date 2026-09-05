type Submission = {
  readonly error?: unknown
}

type Input<T> = {
  readonly submit: () => Promise<Submission>
  readonly terminal: Promise<T>
  readonly cancel: () => void
  readonly onPromptError?: (error: unknown) => void | Promise<void>
  readonly drain: () => Promise<void>
  readonly timeoutMs: number
}

export type Result<T> =
  | {
      readonly promptError: unknown
    }
  | {
      readonly terminal: T
    }

export async function settleNonInteractiveTurn<T>(input: Input<T>): Promise<Result<T>> {
  const terminal = input.terminal.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`BharatCode run did not become idle within ${input.timeoutMs}ms.`)),
      input.timeoutMs,
    )
  })

  try {
    // A successful terminal event cannot replace the submission response, but
    // a failed stream must interrupt a submission that never settles.
    const failure = terminal.then((result) => {
      if (!result.ok) throw result.error
      return new Promise<never>(() => {})
    })
    const submitted = await Promise.race([Promise.resolve().then(input.submit), failure, timeout])
    if (submitted.error !== undefined) {
      await input.onPromptError?.(submitted.error)
      return { promptError: submitted.error }
    }
    const result = await Promise.race([terminal, timeout])
    if (!result.ok) throw result.error
    return { terminal: result.value }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      input.cancel()
    } finally {
      await input.drain()
    }
  }
}
