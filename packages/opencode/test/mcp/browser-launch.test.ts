import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { McpBrowser } from "../../src/mcp/browser"

test("native Windows MCP authorization uses the host-profile launcher exactly once", async () => {
  const urls: string[] = []
  const browser = McpBrowser.make({
    platform: "win32",
    launchWindows: async (url) => {
      urls.push(url)
    },
    launch: async () => {
      throw Error("must not inherit isolated sidecar environment")
    },
  })
  const url = "https://provider.invalid/authorize?state=synthetic-private-state"
  await Effect.runPromise(browser.open(url))
  expect(urls).toEqual([url])
})

test("MCP authorization rejects non-web or credential-bearing browser targets on every platform", async () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    let calls = 0
    const browser = McpBrowser.make({
      platform,
      launchWindows: async () => {
        calls++
      },
      launch: async () => {
        calls++
        return new EventEmitter() as ChildProcess
      },
    })
    for (const url of ["file:///private", "javascript:alert(1)", "https://user:secret@provider.invalid", "--bad"]) {
      await expect(Effect.runPromise(browser.open(url))).rejects.toThrow("Could not open MCP authorization")
    }
    expect(calls).toBe(0)
  }
})

test("failed Windows handoff is secret-safe and never falls back to the isolated launcher", async () => {
  let fallbacks = 0
  const browser = McpBrowser.make({
    platform: "win32",
    launchWindows: async () => {
      throw Error("synthetic-secret C:\\private")
    },
    launch: async () => {
      fallbacks++
      throw Error("fallback")
    },
  })
  const result = await Effect.runPromiseExit(browser.open("https://provider.invalid/authorize?state=private"))
  expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|C:\\\\private|state=private/)
  expect(result._tag).toBe("Failure")
  expect(fallbacks).toBe(0)
})

test("non-Windows opener errors are sanitized and terminal events remove listeners", async () => {
  const process = new EventEmitter() as ChildProcess
  const browser = McpBrowser.make({
    platform: "linux",
    launchWindows: async () => {
      throw Error("wrong platform")
    },
    launch: async () => process,
  })
  const running = Effect.runPromiseExit(browser.open("https://provider.invalid/authorize"))
  await new Promise<void>((resolve) =>
    process.once("newListener", (event) => {
      if (event === "error") queueMicrotask(resolve)
    }),
  )
  process.emit("error", Error("private-command-detail"))
  const result = await running
  expect(result._tag).toBe("Failure")
  expect(JSON.stringify(result)).not.toContain("private-command-detail")
  process.emit("error", Error("late-private-detail"))
  process.emit("close", 1)
  expect(process.listenerCount("error")).toBe(0)
  expect(process.listenerCount("exit")).toBe(0)
})

test("cancelled browser observation absorbs late launcher errors until close", async () => {
  const child = new EventEmitter() as ChildProcess
  const observed = new Promise<void>((resolve) =>
    child.once("newListener", (event) => {
      if (event === "error") queueMicrotask(resolve)
    }),
  )
  const browser = McpBrowser.make({ platform: "darwin", launch: async () => child })
  const fiber = Effect.runFork(browser.open("https://provider.invalid/authorize"))
  await observed
  await Effect.runPromise(Fiber.interrupt(fiber))
  child.emit("error", Error("late-private-detail"))
  child.emit("close", 1)
  expect(child.listenerCount("error")).toBe(0)
  expect(child.listenerCount("exit")).toBe(0)
})

test("successful non-Windows launcher exit completes without waiting for the observation timer", async () => {
  const child = new EventEmitter() as ChildProcess
  const observed = new Promise<void>((resolve) =>
    child.once("newListener", (event) => {
      if (event === "error") queueMicrotask(resolve)
    }),
  )
  const browser = McpBrowser.make({ platform: "darwin", launch: async () => child })
  const result = Effect.runPromiseExit(browser.open("https://provider.invalid/authorize"))
  await observed
  child.emit("exit", 0)
  expect((await result)._tag).toBe("Success")
  child.emit("close", 0)
  expect(child.listenerCount("error")).toBe(0)
  expect(child.listenerCount("exit")).toBe(0)
})
