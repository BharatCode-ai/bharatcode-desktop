import { expect, test } from "bun:test"
import { startLoadingInitialization } from "./loading-initialization"
import type { InitStep, ServerReadyData } from "../preload/types"

for (const outcome of ["success", "failure", "disposed"] as const) {
  test(`loading acknowledgement requires terminal success and handles ${outcome}`, async () => {
    let send!: (step: InitStep) => void
    let resolve!: (value: ServerReadyData) => void
    let reject!: (error: Error) => void
    const steps: InitStep[] = []
    const errors: string[] = []
    let completions = 0
    const dispose = startLoadingInitialization({
      wait: (listener) => {
        send = listener
        return new Promise((yes, no) => {
          resolve = yes
          reject = no
        })
      },
      update: (step) => steps.push(step),
      complete: () => {
        completions++
      },
      failed: (message) => errors.push(message),
    })
    send({ phase: "done" })
    send({ phase: "done" })
    await Promise.resolve()
    expect(completions).toBe(0)
    if (outcome === "disposed") dispose()
    if (outcome === "failure") reject(new Error("secret path: C:\\private\\token"))
    else resolve({ url: "http://127.0.0.1:12345", sidecarID: "test" })
    await Promise.resolve()
    expect(completions).toBe(outcome === "success" ? 1 : 0)
    send({ phase: "done" })
    expect(completions).toBe(outcome === "success" ? 1 : 0)
    expect(errors.length).toBe(outcome === "failure" ? 1 : 0)
    expect(errors.join()).not.toMatch(/secret|private|token/)
    dispose()
    const before = steps.length
    send({ phase: "sqlite_waiting" })
    expect(steps.length).toBe(before)
  })
}
