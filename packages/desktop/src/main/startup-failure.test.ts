import { describe, expect, test } from "bun:test"

import { reportStartupFailure } from "./startup-failure"

describe("desktop startup failure", () => {
  test("shows a value-free error and exits when startup fails before a window exists", () => {
    const calls: unknown[] = []
    const secret = "private-startup-detail"

    reportStartupFailure(
      {
        log: (error) => calls.push(["log", error]),
        showError: (title, message) => calls.push(["show", title, message]),
        exit: (code) => calls.push(["exit", code]),
      },
      new Error(secret),
    )

    expect(calls[0]).toEqual(["log", expect.any(Error)])
    expect(calls[1]).toEqual([
      "show",
      "BharatCode could not start",
      "A required desktop component could not start. Reinstall the latest BharatCode Desktop build. Your projects were not changed.",
    ])
    expect(JSON.stringify(calls[1])).not.toContain(secret)
    expect(calls[2]).toEqual(["exit", 1])
  })

  test("still shows the error when logging itself fails", () => {
    const calls: unknown[] = []

    reportStartupFailure(
      {
        log: () => {
          throw new Error("logger unavailable")
        },
        showError: (title, message) => calls.push([title, message]),
        exit: (code) => calls.push(code),
      },
      new Error("startup failed"),
    )

    expect(calls).toEqual([
      [
        "BharatCode could not start",
        "A required desktop component could not start. Reinstall the latest BharatCode Desktop build. Your projects were not changed.",
      ],
      1,
    ])
  })
})
