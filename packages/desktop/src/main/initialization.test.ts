import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { awaitInitialization } from "./initialization"
import type { InitStep, ServerReadyData } from "../preload/types"

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
  const events = new EventEmitter()
  const server = pending<ServerReadyData>()
  const terminal = pending<void>()
  const abort = new AbortController()
  const steps: InitStep[] = []
  let step: InitStep = { phase: "server_waiting" }
  const response = { url: "http://127.0.0.1:12345", sidecarID: "synthetic-sidecar" }
  const wait = () =>
    awaitInitialization({
      current: () => step,
      subscribe: (listener) => {
        events.on("step", listener)
        return () => {
          events.off("step", listener)
        }
      },
      server: server.promise,
      terminal: terminal.promise,
      signal: abort.signal,
      send: (value) => steps.push(value),
    })
  const done = () => {
    step = { phase: "done" }
    events.emit("step", step)
    terminal.resolve()
  }
  return { events, server, terminal, abort, steps, response, wait, done }
}

test("ready before terminal without SQLite retains its subscription and does not resolve early", async () => {
  const f = fixture()
  let resolved = false
  const result = f.wait().then((value) => {
    resolved = true
    return value
  })
  f.server.resolve(f.response)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(resolved).toBe(false)
  expect(f.events.listenerCount("step")).toBe(1)
  f.done()
  expect(await result).toEqual(f.response)
  expect(f.steps.at(-1)).toEqual({ phase: "done" })
  expect(f.events.listenerCount("step")).toBe(0)
})

test("terminal before server and late subscribers still require both successful barriers", async () => {
  const f = fixture()
  f.done()
  let resolved = false
  const result = f.wait().then((value) => {
    resolved = true
    return value
  })
  await Promise.resolve()
  expect(resolved).toBe(false)
  f.server.resolve(f.response)
  expect(await result).toEqual(f.response)
  expect(f.steps[0]).toEqual({ phase: "done" })
  expect(await f.wait()).toEqual(f.response)
  expect(f.events.listenerCount("step")).toBe(0)
})

for (const barrier of ["server", "terminal"] as const) {
  test(`${barrier} failure rejects and removes its listener without terminal success`, async () => {
    const f = fixture()
    const result = f.wait()
    f[barrier].reject(new Error("synthetic failure"))
    await expect(result).rejects.toThrow("synthetic failure")
    expect(f.events.listenerCount("step")).toBe(0)
    expect(f.steps.some((step) => step.phase === "done")).toBe(false)
  })
}

test("destroyed renderer cancels its waiter and removes listeners", async () => {
  const f = fixture()
  const result = f.wait()
  f.abort.abort()
  await expect(result).rejects.toThrow("Initialization observer closed")
  expect(f.events.listenerCount("step")).toBe(0)
  f.server.resolve(f.response)
  f.done()
  expect(f.steps).toEqual([{ phase: "server_waiting" }])
})

test("already disposed subscription does not emit or register", async () => {
  const f = fixture()
  f.abort.abort()
  await expect(f.wait()).rejects.toThrow("Initialization observer closed")
  expect(f.events.listenerCount("step")).toBe(0)
  expect(f.steps).toEqual([])
})

test("production wiring gates completion on successful health/startup and the current overlay", async () => {
  const main = await readFile(new URL("./index.ts", import.meta.url), "utf8")
  const ipc = await readFile(new URL("./ipc.ts", import.meta.url), "utf8")
  const loading = await readFile(new URL("../renderer/loading.tsx", import.meta.url), "utf8")
  expect(main).toContain("terminal: Effect.runPromise(Deferred.await(initializationDone))")
  expect(main).toContain("Fiber.join(loadingTask)")
  expect(main).toContain("Deferred.failCause(initializationDone, cause)")
  expect(main.indexOf("Fiber.join(loadingTask)")).toBeLessThan(main.indexOf("initializationSucceeded = true"))
  expect(main.indexOf('setInitStep({ phase: "done" })')).toBeLessThan(main.indexOf("Deferred.await(loadingComplete)"))
  expect(main).toContain("initializationSucceeded && overlay?.webContents.id === senderID")
  expect(ipc).toContain('event.sender.once("destroyed", dispose)')
  expect(ipc).toContain('event.sender.removeListener("destroyed", dispose)')
  expect(loading).toContain("startLoadingInitialization")
  expect(loading).not.toMatch(/setTimeout\([^\n]*loadingWindowComplete/)
})
