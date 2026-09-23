import { describe, expect, test } from "bun:test"
import { settleNonInteractiveTurn } from "@/cli/cmd/run/noninteractive-turn"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("noninteractive run completion", () => {
  test("preserves typed 402 denial without waiting for an idle event", async () => {
    const denial = {
      name: "APIError",
      data: {
        statusCode: 402,
        errorCode: "subscription_required",
        message: "subscription required",
        isRetriable: false,
      },
    }
    const reported: unknown[] = []
    expect(
      await settleNonInteractiveTurn({
        submit: async () => ({ error: denial }),
        terminal: new Promise(() => {}),
        cancel: () => {},
        drain: async () => {},
        onPromptError: (error) => {
          reported.push(error)
        },
        timeoutMs: 100,
      }),
    ).toEqual({ promptError: denial })
    expect(reported).toEqual([denial])
  })

  test("propagates stdout failure instead of reporting success", async () => {
    await expect(
      settleNonInteractiveTurn({
        submit: async () => ({}),
        terminal: Promise.resolve(),
        cancel: () => {},
        drain: async () => {
          throw new Error("stdout failed")
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow("stdout failed")
  })
  test.each(["throw", "reject"])("cancels and drains when submission %s fails", async (mode) => {
    const order: string[] = []
    await expect(
      settleNonInteractiveTurn({
        submit: () => {
          if (mode === "throw") throw new Error("submission failed")
          return Promise.reject(new Error("submission failed"))
        },
        terminal: new Promise(() => {}),
        cancel: () => {
          order.push("cancel")
        },
        drain: async () => {
          order.push("drain")
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("submission failed")
    expect(order).toEqual(["cancel", "drain"])
  })

  test("deadline includes a pending submission", async () => {
    let cancelled = false
    await expect(
      settleNonInteractiveTurn({
        submit: () => new Promise(() => {}),
        terminal: new Promise(() => {}),
        cancel: () => {
          cancelled = true
        },
        drain: async () => {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow("did not become idle")
    expect(cancelled).toBe(true)
  }, 200)

  test("terminal failure interrupts pending submission", async () => {
    let cancelled = false
    await expect(
      settleNonInteractiveTurn({
        submit: () => new Promise(() => {}),
        terminal: Promise.reject(new Error("stream failed")),
        cancel: () => {
          cancelled = true
        },
        drain: async () => {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow("stream failed")
    expect(cancelled).toBe(true)
  }, 200)

  test("terminal success alone cannot complete a pending submission", async () => {
    await expect(
      settleNonInteractiveTurn({
        submit: () => new Promise(() => {}),
        terminal: Promise.resolve("idle"),
        cancel: () => {},
        drain: async () => {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow("did not become idle")
  }, 200)

  test("waits for stdout drain after terminal completion", async () => {
    const drain = deferred()
    let finished = false
    const running = settleNonInteractiveTurn({
      submit: async () => ({}),
      terminal: Promise.resolve(),
      cancel: () => {},
      drain: () => drain.promise,
      timeoutMs: 1000,
    }).then(() => {
      finished = true
    })
    await Bun.sleep(10)
    expect(finished).toBe(false)
    drain.resolve()
    await running
    expect(finished).toBe(true)
  })
  test("returns a prompt error without waiting for terminal idle", async () => {
    const terminal = deferred()
    const order: string[] = []
    const error = { message: "unknown model" }
    const result = await settleNonInteractiveTurn({
      submit: async () => ({ error }),
      terminal: terminal.promise,
      cancel: () => {
        order.push("cancelled")
        terminal.reject(new Error("cancelled"))
      },
      onPromptError: async () => {
        order.push("reported")
      },
      drain: async () => {
        order.push("drained")
      },
      timeoutMs: 1_000,
    })

    expect(result).toEqual({ promptError: error })
    expect(order).toEqual(["reported", "cancelled", "drained"])
  })

  test("waits for terminal completion before draining", async () => {
    const terminal = deferred()
    const order: string[] = []
    const run = settleNonInteractiveTurn({
      submit: async () => {
        order.push("submitted")
        return {}
      },
      terminal: terminal.promise.then(() => {
        order.push("terminal")
        return "idle"
      }),
      cancel: () => order.push("cancelled"),
      drain: async () => {
        order.push("drained")
      },
      timeoutMs: 1_000,
    })

    await Bun.sleep(10)
    expect(order).toEqual(["submitted"])
    terminal.resolve()
    expect(await run).toEqual({ terminal: "idle" })
    expect(order).toEqual(["submitted", "terminal", "cancelled", "drained"])
  })

  test("rejects a stream that closes before terminal idle", async () => {
    await expect(
      settleNonInteractiveTurn({
        submit: async () => ({}),
        terminal: Promise.reject(new Error("event stream closed before session became idle")),
        cancel: () => {},
        drain: async () => {},
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("event stream closed before session became idle")
  })

  test("rejects when accepted work never reaches terminal idle", async () => {
    await expect(
      settleNonInteractiveTurn({
        submit: async () => ({}),
        terminal: new Promise(() => {}),
        cancel: () => {},
        drain: async () => {},
        timeoutMs: 10,
      }),
    ).rejects.toThrow("did not become idle")
  })
})
