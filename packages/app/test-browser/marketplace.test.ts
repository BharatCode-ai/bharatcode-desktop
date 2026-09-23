import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createMarketplaceController } from "@/components/marketplace-controller"

const snapshot = () => ({
  catalog: [],
  state: { version: 1 as const, installed: {} },
  configuration: { scope: "runtime-defaults" as const, entries: {} },
})

test("marketplace suppresses duplicate mutations and reloads only on explicit action", async () => {
  let finish!: () => void
  let changes = 0
  let reloads = 0
  const app = createRoot((dispose) => ({
    dispose,
    controller: createMarketplaceController({
      scope: () => "native",
      read: async () => snapshot(),
      change: async () => {
        changes++
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return { version: 1, installed: { github: { enabled: true } } }
      },
      reload: async () => {
        reloads++
      },
    }),
  }))
  await app.controller.refresh()
  const first = app.controller.change("github", "enable")
  await app.controller.change("github", "enable")
  expect(changes).toBe(1)
  finish()
  await first
  expect(app.controller.state.snapshot?.state.installed.github.enabled).toBe(true)
  expect(app.controller.state.reloadRequired).toBe(true)
  expect(app.controller.state.snapshot?.configuration).toBeUndefined()
  expect(reloads).toBe(0)
  await app.controller.reload()
  expect(reloads).toBe(1)
  expect(app.controller.state.reloadRequired).toBe(false)
  app.dispose()
})

test("failed mutation preserves prior state, sanitizes errors, and requires a read before another change", async () => {
  let calls = 0
  const app = createRoot((dispose) => ({
    dispose,
    controller: createMarketplaceController({
      scope: () => "native",
      read: async () => snapshot(),
      change: async () => {
        calls++
        throw Error("secret-token=/private/store")
      },
      reload: async () => {},
    }),
  }))
  await app.controller.refresh()
  await app.controller.change("github", "enable")
  expect(app.controller.state.error).toBe("change")
  expect(app.controller.state.uncertain).toBe(true)
  expect(app.controller.state.snapshot?.state.installed).toEqual({})
  expect(JSON.stringify(app.controller.state)).not.toContain("secret-token")
  await app.controller.change("github", "enable")
  expect(calls).toBe(1)
  await app.controller.refresh()
  expect(app.controller.state.uncertain).toBe(false)
  expect(app.controller.state.reloadRequired).toBe(true)
  app.dispose()
})

test("runtime switch and disposal reject delayed results without mutating the new scope", async () => {
  let finish!: (state: ReturnType<typeof snapshot>) => void
  let signal!: AbortSignal
  const app = createRoot((dispose) => {
    const [scope, setScope] = createSignal("native")
    return {
      dispose,
      setScope,
      controller: createMarketplaceController({
        scope,
        read: async (runtime, abort) =>
          runtime === "native"
            ? new Promise((resolve) => {
                signal = abort
                finish = resolve
              })
            : snapshot(),
        change: async () => ({ version: 1, installed: {} }),
        reload: async () => {},
      }),
    }
  })
  const first = app.controller.refresh()
  app.setScope("wsl")
  await app.controller.refresh()
  expect(signal.aborted).toBe(true)
  finish({ ...snapshot(), state: { version: 1, installed: { github: { enabled: true } } } })
  await first
  expect(app.controller.state.snapshot?.state.installed).toEqual({})
  app.dispose()
  await app.controller.refresh()
  expect(app.controller.state.busy).toBeUndefined()
})

test("reload failure remains actionable and does not clear pending changes", async () => {
  const app = createRoot((dispose) => ({
    dispose,
    controller: createMarketplaceController({
      scope: () => "native",
      read: async () => snapshot(),
      change: async () => ({ version: 1, installed: { github: { enabled: true } } }),
      reload: async () => {
        throw Error("private-server-error")
      },
    }),
  }))
  await app.controller.refresh()
  await app.controller.change("github", "enable")
  await app.controller.reload()
  expect(app.controller.state.reloadRequired).toBe(true)
  expect(app.controller.state.error).toBe("reload")
  expect(app.controller.state.uncertain).toBe(true)
  expect(app.controller.state.busy).toBeUndefined()
  app.dispose()
})

test("a mutation completing after runtime change cannot replace the new runtime's choices", async () => {
  let finish!: (state: { version: 1; installed: Record<string, { enabled: boolean }> }) => void
  const app = createRoot((dispose) => {
    const [scope, setScope] = createSignal("native")
    return {
      dispose,
      setScope,
      controller: createMarketplaceController({
        scope,
        read: async () => snapshot(),
        change: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
        reload: async () => {},
      }),
    }
  })
  await app.controller.refresh()
  const changing = app.controller.change("github", "enable")
  app.setScope("wsl")
  await app.controller.refresh()
  finish({ version: 1, installed: { github: { enabled: true } } })
  await changing
  expect(app.controller.state.snapshot?.state.installed).toEqual({})
  expect(app.controller.state.reloadRequired).toBe(false)
  app.dispose()
})
