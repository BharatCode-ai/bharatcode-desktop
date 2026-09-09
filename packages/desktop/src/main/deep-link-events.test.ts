import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createDeepLinkEvents } from "./deep-link-events"

const secret = "seeded-code-state-access-refresh-fragment"
const callback = `bharatcode://auth/callback?code=${secret}&state=${secret}&access_token=${secret}#${secret}`

for (const source of ["second-instance", "open-url"] as const) {
  for (const fails of [false, true]) {
    test(`${source} emits no callback or invalid-input payloads, including errors and duplicates (${fails})`, async () => {
      const logs: unknown[][] = []
      const seen: string[] = []
      const forwarded: string[][] = []
      const pending: string[] = []
      const events = createDeepLinkEvents({
        protocol: "bharatcode",
        pending,
        client: () => ({
          completeSignIn: async (url) => {
            seen.push(url)
            if (fails) throw new Error(url)
          },
        }),
        forward: async (urls) => {
          forwarded.push(urls)
          if (fails) throw new Error(JSON.stringify(urls))
        },
        log: (...args) => {
          logs.push(args)
        },
      })
      for (const url of [callback, callback, `bharatcode://invalid?payload=${secret}`, `not-a-url-${secret}`]) {
        if (source === "second-instance") await events.secondInstance(["app.exe", url])
        else await events.openUrl({ preventDefault() {} }, url)
      }
      expect(seen).toEqual([callback, callback])
      expect(forwarded.flat()).toContain(`bharatcode://invalid?payload=${secret}`)
      expect(pending).toEqual([])
      expect(logs.length).toBeGreaterThan(0)
      expect(JSON.stringify(logs)).not.toMatch(/seeded|code=|state=|access_token|bharatcode:\/\/|not-a-url|app\.exe/)
      expect(logs.every((entry) => entry.length === 1 && typeof entry[0] === "string")).toBe(true)
    })
  }
}

test("queued callback forwarding errors use the same payload-free logging boundary", async () => {
  const logs: unknown[][] = []
  const pending: string[] = []
  let ready = false
  const received: string[] = []
  const events = createDeepLinkEvents({
    protocol: "bharatcode",
    pending,
    client: () =>
      ready
        ? {
            completeSignIn: async (url) => {
              received.push(url)
              throw new Error(url)
            },
          }
        : undefined,
    forward: async () => {},
    log: (...args) => {
      logs.push(args)
    },
  })
  await events.openUrl({ preventDefault() {} }, callback)
  expect(pending).toEqual([callback])
  ready = true
  await events.flush()
  expect(received).toEqual([callback])
  expect(pending).toEqual([])
  expect(JSON.stringify(logs)).not.toContain(secret)
})

test("synchronous dispatch failures cannot escape into URL-bearing uncaught errors", async () => {
  const logs: unknown[][] = []
  const events = createDeepLinkEvents({
    protocol: "bharatcode",
    pending: [],
    client: () => {
      throw new Error(callback)
    },
    forward: () => {
      throw new Error(secret)
    },
    log: (...args) => {
      logs.push(args)
    },
  })
  await events.secondInstance([callback])
  await events.openUrl({ preventDefault() {} }, `bharatcode://invalid?${secret}`)
  expect(logs).toEqual([
    ["desktop second-instance link received"],
    ["desktop link dispatch failed"],
    ["desktop open-url link received"],
    ["desktop link dispatch failed"],
  ])
})

test("production callback entrypoints and deferred forwarding use the tested boundary", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  expect(source).toContain("deepLinkEvents.secondInstance(argv)")
  expect(source).toContain("deepLinkEvents.openUrl(event, url)")
  expect(source).toContain("deepLinkEvents.flush()")
  expect(source).not.toContain('logger.log("deep link received')
  expect(source).not.toContain('logger.warn("failed to handle BharatCode auth callback", error)')
  expect(source).not.toContain('logger.warn("failed to complete BharatCode sign-in", error)')
})
