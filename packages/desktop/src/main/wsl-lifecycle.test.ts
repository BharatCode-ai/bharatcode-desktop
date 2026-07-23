import { describe, expect, test } from "bun:test"
import type { WslStatus } from "./wsl-contract"
import { createSidecarAuthorizationPolicy, type SidecarAuthorizationPolicy } from "./sidecar-auth"
import {
  configureWslForControlledRelaunch,
  WslLifecycleFailure,
  classifyWslLaunchFailure,
  createWslLifecycle,
  retainWslAuthorizationWhileRunning,
  rewriteWslProjectDeepLinks,
  type WslOwnedRuntime,
} from "./wsl-lifecycle"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runtime(name: string, effects: string[]) {
  const stopped = deferred()
  const exited = deferred()
  let stopping: Promise<void> | undefined
  const owned: WslOwnedRuntime = {
    exited: exited.promise,
    stop() {
      effects.push(`stop:${name}`)
      stopping ??= stopped.promise
      return stopping
    },
    closeInput() {
      effects.push(`close:${name}`)
    },
  }
  return { owned, stopped, exited }
}

async function until(check: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("condition did not settle")
}

describe("lean WSL owned-child lifecycle", () => {
  test("double stop is idempotent and waits for both the closed stop and child exit", async () => {
    const effects: string[] = []
    const child = runtime("one", effects)
    let active: SidecarAuthorizationPolicy | undefined
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => child.owned,
      onStatus: (status) => {
        active = retainWslAuthorizationWhileRunning(status, active)
      },
    })
    await lifecycle.start()
    const accepted = createSidecarAuthorizationPolicy({
      origin: "http://127.0.0.1:4096",
      username: "bharatcode",
      password: "stop-secret",
    })
    active = accepted

    const first = lifecycle.stop()
    const second = lifecycle.stop()
    expect(first).toBe(second)
    expect(active).toBeUndefined()
    expect(accepted.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(false)
    await Promise.resolve()
    expect(effects).toEqual(["revalidate", "stop:one"])
    expect(lifecycle.status()).toEqual({ phase: "starting" })

    child.stopped.resolve()
    await Promise.resolve()
    expect(lifecycle.status()).toEqual({ phase: "starting" })
    child.exited.resolve()
    await first
    expect(lifecycle.status()).toEqual({ phase: "ready" })
  })

  test("exit during stop fails closed without signaling a process or distribution", async () => {
    const effects: string[] = []
    const child = runtime("one", effects)
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => child.owned,
    })
    await lifecycle.start()

    const stopping = lifecycle.stop()
    child.exited.resolve()
    child.stopped.reject(new Error("stdout ended before stopped"))
    await expect(stopping).rejects.toThrow("stop")
    expect(lifecycle.status()).toEqual({ phase: "error", code: "stop-failed" })
    expect(effects).toEqual(["revalidate", "stop:one"])
  })

  test("a crash before ready uses the single 250ms reconnect allowance", async () => {
    const effects: string[] = []
    const replacement = runtime("replacement", effects)
    let starts = 0
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => {
        starts += 1
        effects.push(`start:${starts}`)
        if (starts === 1) throw new WslLifecycleFailure("connection-lost", { reconnectable: true })
        return replacement.owned
      },
      delay: async (milliseconds) => effects.push(`delay:${milliseconds}`),
    })

    await lifecycle.start()
    expect(effects).toEqual(["revalidate", "start:1", "delay:250", "revalidate", "start:2"])
    expect(lifecycle.status()).toEqual({ phase: "running" })
  })

  test("one unexpected exit reconnects once and a second crash becomes connection-lost", async () => {
    const effects: string[] = []
    const first = runtime("first", effects)
    const second = runtime("second", effects)
    const runtimes = [first, second]
    let starts = 0
    const statuses: WslStatus[] = []
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => {
        effects.push(`start:${starts + 1}`)
        return runtimes[starts++].owned
      },
      delay: async (milliseconds) => effects.push(`delay:${milliseconds}`),
      onStatus: (status) => statuses.push(status),
    })

    await lifecycle.start()
    first.exited.resolve()
    await until(() => starts === 2)
    expect(effects).toEqual(["revalidate", "start:1", "delay:250", "revalidate", "start:2"])

    second.exited.resolve()
    await until(() => lifecycle.status().phase === "error")
    expect(lifecycle.status()).toEqual({ phase: "error", code: "connection-lost" })
    expect(starts).toBe(2)
    expect(statuses.at(-1)).toEqual({ phase: "error", code: "connection-lost" })
  })

  test("revokes the accepted Basic policy before reconnect delay and keeps it revoked after replacement failure", async () => {
    const first = runtime("first", [])
    const delayEntered = deferred()
    const releaseDelay = deferred()
    const accepted = createSidecarAuthorizationPolicy({
      origin: "http://127.0.0.1:4096",
      username: "bharatcode",
      password: "first-secret",
    })
    let active: SidecarAuthorizationPolicy | undefined
    let starts = 0
    const lifecycle = createWslLifecycle({
      revalidate: async () => undefined,
      startOwned: async () => {
        starts += 1
        if (starts === 1) {
          active = accepted
          return first.owned
        }
        throw new WslLifecycleFailure("prerequisite-missing")
      },
      delay: async () => {
        delayEntered.resolve()
        await releaseDelay.promise
      },
      onStatus: (status) => {
        active = retainWslAuthorizationWhileRunning(status, active)
      },
    })

    await lifecycle.start()
    expect(accepted.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(true)

    first.exited.resolve()
    await delayEntered.promise
    expect(active).toBeUndefined()
    expect(accepted.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(false)

    releaseDelay.resolve()
    await until(() => lifecycle.status().phase === "error")
    expect(lifecycle.status()).toEqual({ phase: "error", code: "prerequisite-missing" })
    expect(active).toBeUndefined()
    expect(accepted.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(false)
  })

  test("child loss revokes Basic authorization even while an older serialized operation is still in flight", async () => {
    const first = runtime("first", [])
    const translationEntered = deferred()
    const releaseTranslation = deferred()
    const delayEntered = deferred()
    const accepted = createSidecarAuthorizationPolicy({
      origin: "http://127.0.0.1:4096",
      username: "bharatcode",
      password: "queued-secret",
    })
    let active: SidecarAuthorizationPolicy | undefined
    const lifecycle = createWslLifecycle({
      revalidate: async () => undefined,
      startOwned: async () => {
        active = accepted
        return first.owned
      },
      delay: async () => {
        delayEntered.resolve()
      },
      onStatus: (status) => {
        active = retainWslAuthorizationWhileRunning(status, active)
      },
    })
    await lifecycle.start()
    const translating = lifecycle.translateProjectPaths(["C:\\work"], async () => {
      translationEntered.resolve()
      await releaseTranslation.promise
      return "/mnt/c/work"
    })
    await translationEntered.promise

    first.exited.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(active).toBeUndefined()
    expect(accepted.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(false)

    releaseTranslation.resolve()
    await translating
    await delayEntered.promise
  })

  test("retains Basic authorization only for the closed running phase", () => {
    const makePolicy = () =>
      createSidecarAuthorizationPolicy({
        origin: "http://127.0.0.1:4096",
        username: "bharatcode",
        password: "phase-secret",
      })
    const running = makePolicy()
    expect(retainWslAuthorizationWhileRunning({ phase: "running" }, running)).toBe(running)
    expect(running.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(true)

    for (const status of [
      { phase: "off" as const },
      { phase: "ready" as const },
      { phase: "starting" as const },
      { phase: "error" as const, code: "prerequisite-missing" as const },
      { phase: "error" as const, code: "runtime-integrity" as const },
      { phase: "error" as const, code: "selection-invalid" as const },
      { phase: "error" as const, code: "connection-lost" as const },
    ]) {
      const policy = makePolicy()
      expect(retainWslAuthorizationWhileRunning(status, policy)).toBeUndefined()
      expect(policy.authorize("http://127.0.0.1:4096/session", new Headers()).has("authorization")).toBe(false)
    }
  })

  test("explicit retry restarts after a crash loop without resetting automatic recovery", async () => {
    const effects: string[] = []
    const first = runtime("first", effects)
    const second = runtime("second", effects)
    const third = runtime("third", effects)
    const runtimes = [first, second, third]
    let starts = 0
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => runtimes[starts++].owned,
      delay: async () => undefined,
    })

    await lifecycle.start()
    first.exited.resolve()
    await until(() => starts === 2)
    second.exited.resolve()
    await until(() => lifecycle.status().phase === "error")
    await lifecycle.retry()
    expect(starts).toBe(3)
    expect(lifecycle.status()).toEqual({ phase: "running" })

    third.exited.resolve()
    await until(() => lifecycle.status().phase === "error")
    expect(starts).toBe(3)
  })

  test("a failed automatic replacement remains a closed visible error", async () => {
    const effects: string[] = []
    const first = runtime("first", effects)
    let starts = 0
    const lifecycle = createWslLifecycle({
      revalidate: async () => undefined,
      startOwned: async () => {
        starts += 1
        if (starts === 1) return first.owned
        throw new WslLifecycleFailure("prerequisite-missing")
      },
      delay: async () => undefined,
    })
    await lifecycle.start()
    first.exited.resolve()
    await until(() => lifecycle.status().phase === "error")
    expect(lifecycle.status()).toEqual({ phase: "error", code: "prerequisite-missing" })
  })

  test("restart stops the retained child and revalidates before exactly one replacement", async () => {
    const effects: string[] = []
    const first = runtime("first", effects)
    const second = runtime("second", effects)
    const runtimes = [first, second]
    let starts = 0
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => runtimes[starts++].owned,
    })

    await lifecycle.start()
    const restarting = lifecycle.restart()
    first.stopped.resolve()
    first.exited.resolve()
    await restarting
    expect(effects).toEqual(["revalidate", "stop:first", "revalidate"])
    expect(starts).toBe(2)
    expect(lifecycle.status()).toEqual({ phase: "running" })
  })

  test("Retry replaces a still-running child after a recoverable boundary error", async () => {
    const effects: string[] = []
    const first = runtime("first", effects)
    const second = runtime("second", effects)
    const runtimes = [first, second]
    let starts = 0
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => runtimes[starts++].owned,
    })
    await lifecycle.start()
    await expect(
      lifecycle.translateProjectPaths(["C:\\blocked"], async () => {
        throw new Error("round trip failed")
      }),
    ).rejects.toThrow("path-translation")

    const retrying = lifecycle.retry()
    first.stopped.resolve()
    first.exited.resolve()
    await retrying
    expect(starts).toBe(2)
    expect(effects).toContain("stop:first")
    expect(lifecycle.status()).toEqual({ phase: "running" })
  })

  test("stale, replaced, missing-prerequisite, and runtime-integrity failures stay actionable", async () => {
    for (const code of ["selection-invalid", "prerequisite-missing", "runtime-integrity"] as const) {
      let starts = 0
      const lifecycle = createWslLifecycle({
        revalidate: async () => {
          throw new WslLifecycleFailure(code)
        },
        startOwned: async () => {
          starts += 1
          throw new Error("must not start")
        },
      })
      await expect(lifecycle.start()).rejects.toThrow(code)
      expect(starts).toBe(0)
      expect(lifecycle.status()).toEqual({ phase: "error", code })
    }
  })

  test("classifies launch failures into the closed actionable status contract", () => {
    expect(classifyWslLaunchFailure(new Error("Selected WSL user must be non-root")).code).toBe("root-user")
    expect(classifyWslLaunchFailure(new Error("spawn /usr/bin/getent ENOENT")).code).toBe("prerequisite-missing")
    expect(classifyWslLaunchFailure(new Error("Command failed: /usr/bin/getent passwd alice")).code).toBe(
      "prerequisite-missing",
    )
    expect(classifyWslLaunchFailure(new Error("WSL runtime manifest digest mismatch")).code).toBe("runtime-integrity")
    expect(classifyWslLaunchFailure(new Error("wslpath round trip failed")).code).toBe("path-translation")
    expect(classifyWslLaunchFailure(new Error("WSL runtime exited before ready"))).toMatchObject({
      code: "connection-lost",
      options: { reconnectable: true },
    })
    expect(classifyWslLaunchFailure(new Error("bind failed")).code).toBe("start-failed")
  })

  test("picker paths and project deep links revalidate and fail closed without a Windows fallback", async () => {
    const effects: string[] = []
    const child = runtime("one", effects)
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => child.owned,
    })
    const translate = async (path: string) => {
      effects.push(`translate:${path}`)
      if (path.includes("blocked")) throw new Error("round trip failed")
      return `/mnt/c/${path.slice(3).replaceAll("\\", "/")}`
    }

    expect(await lifecycle.translateProjectPaths(["C:\\work\\one", "C:\\work\\two"], translate)).toEqual([
      "/mnt/c/work/one",
      "/mnt/c/work/two",
    ])
    expect(effects).toEqual(["revalidate", "translate:C:\\work\\one", "translate:C:\\work\\two"])
    const links = await rewriteWslProjectDeepLinks(
      [
        "bharatcode://open-project?directory=C%3A%5Cwork%5Cone",
        "bharatcode://new-session?directory=C%3A%5Cwork%5Ctwo&prompt=hello",
      ],
      (paths) => lifecycle.translateProjectPaths(paths, translate),
    )
    expect(links).toEqual([
      "bharatcode://open-project?directory=%2Fmnt%2Fc%2Fwork%2Fone",
      "bharatcode://new-session?directory=%2Fmnt%2Fc%2Fwork%2Ftwo&prompt=hello",
    ])

    await expect(lifecycle.translateProjectPaths(["C:\\blocked"], translate)).rejects.toThrow("path-translation")
    expect(lifecycle.status()).toEqual({ phase: "error", code: "path-translation" })

    const invalid = createWslLifecycle({
      revalidate: async () => {
        throw new WslLifecycleFailure("root-user")
      },
      startOwned: async () => child.owned,
    })
    await expect(invalid.translateProjectPaths(["C:\\work"], translate)).rejects.toThrow("root-user")
    expect(invalid.status()).toEqual({ phase: "error", code: "root-user" })
  })

  test("Desktop EOF closes only the retained child input and leaves unrelated work untouched", async () => {
    const effects: string[] = []
    const child = runtime("owned", effects)
    const unrelated = { state: "alive" }
    const lifecycle = createWslLifecycle({
      revalidate: async () => effects.push("revalidate"),
      startOwned: async () => child.owned,
    })
    await lifecycle.start()

    lifecycle.closeInput()
    expect(effects).toEqual(["revalidate", "close:owned"])
    expect(unrelated.state).toBe("alive")

    const source = await Bun.file(new URL("./wsl-lifecycle.ts", import.meta.url)).text()
    expect(source).not.toMatch(/process\.kill|child\.kill|--terminate|\b(?:taskkill|SIGTERM|SIGKILL|PID|PGID)\b/u)
  })

  test("projects only the existing renderer-safe lifecycle status", async () => {
    const effects: string[] = []
    const child = runtime("owned", effects)
    const lifecycle = createWslLifecycle({
      revalidate: async () => undefined,
      startOwned: async () => child.owned,
    })
    const snapshot = {
      enabled: true,
      revision: 4,
      selectedDisplayName: "Ubuntu 24.04",
      distributions: [{ displayName: "Ubuntu 24.04", version: 2 as const, selected: true }],
      status: { phase: "ready" as const },
    }
    await lifecycle.start()
    expect(lifecycle.projectSnapshot(snapshot)).toEqual({ ...snapshot, status: { phase: "running" } })
    expect(JSON.stringify(lifecycle.projectSnapshot(snapshot))).not.toMatch(
      /instance|user|uid|digest|process|transport/iu,
    )
    expect(lifecycle.projectSnapshot({ ...snapshot, enabled: false, status: { phase: "off" } })).toEqual({
      ...snapshot,
      enabled: false,
      status: { phase: "off" },
    })
    expect(lifecycle.projectSnapshot({ ...snapshot, status: { phase: "error", code: "selection-invalid" } })).toEqual({
      ...snapshot,
      status: { phase: "error", code: "selection-invalid" },
    })
  })

  test("configuration changes persist before one controlled relaunch without claiming the new runtime is active", async () => {
    const cases = [
      {
        name: "native to WSL",
        before: {
          enabled: false,
          revision: 1,
          distributions: [{ displayName: "Ubuntu", version: 2 as const, selected: false }],
          status: { phase: "off" as const },
        },
        configured: {
          enabled: true,
          revision: 2,
          selectedDisplayName: "Ubuntu",
          distributions: [{ displayName: "Ubuntu", version: 2 as const, selected: true }],
          status: { phase: "ready" as const },
        },
        update: { enabled: true as const, expectedRevision: 1, selectedDisplayName: "Ubuntu" },
      },
      {
        name: "WSL to native",
        before: {
          enabled: true,
          revision: 2,
          selectedDisplayName: "Ubuntu",
          distributions: [{ displayName: "Ubuntu", version: 2 as const, selected: true }],
          status: { phase: "running" as const },
        },
        configured: {
          enabled: false,
          revision: 3,
          distributions: [{ displayName: "Ubuntu", version: 2 as const, selected: false }],
          status: { phase: "off" as const },
        },
        update: { enabled: false as const, expectedRevision: 2 },
      },
      {
        name: "selected distro replacement",
        before: {
          enabled: true,
          revision: 3,
          selectedDisplayName: "Ubuntu",
          distributions: [
            { displayName: "Ubuntu", version: 2 as const, selected: true },
            { displayName: "Debian", version: 2 as const, selected: false },
          ],
          status: { phase: "running" as const },
        },
        configured: {
          enabled: true,
          revision: 4,
          selectedDisplayName: "Debian",
          distributions: [
            { displayName: "Ubuntu", version: 2 as const, selected: false },
            { displayName: "Debian", version: 2 as const, selected: true },
          ],
          status: { phase: "ready" as const },
        },
        update: { enabled: true as const, expectedRevision: 3, selectedDisplayName: "Debian" },
      },
    ]

    for (const item of cases) {
      const effects: string[] = []
      const result = await configureWslForControlledRelaunch(item.update, {
        snapshot: async () => {
          effects.push("snapshot")
          return item.before
        },
        configure: async () => {
          effects.push("configure")
          return item.configured
        },
        relaunch: async () => {
          effects.push("relaunch")
        },
      })
      expect(effects, item.name).toEqual(["snapshot", "configure", "relaunch"])
      expect(result, item.name).toEqual({
        ...item.before,
        revision: item.configured.revision,
        status: { phase: "starting" },
      })
    }
  })

  test("composition routes startup, retry, picker, and deep links through the narrow lifecycle boundary", async () => {
    const index = await Bun.file(new URL("./index.ts", import.meta.url)).text()
    const ipc = await Bun.file(new URL("./ipc.ts", import.meta.url)).text()
    const server = await Bun.file(new URL("./server.ts", import.meta.url)).text()

    expect(index).toContain("createWslLifecycle")
    expect(index).toContain("rewriteWslProjectDeepLinks")
    expect(index).toContain("translateProjectPaths")
    expect(index).toContain("wslLifecycle.retry")
    expect(index).toContain("configureWslForControlledRelaunch")
    expect(index).toContain("retainWslAuthorizationWhileRunning")
    expect(index).not.toMatch(/configureWsl:[\s\S]*?wslLifecycle\.(?:stop|restart)\(\)/u)
    expect(index).toMatch(
      /async function relaunchDesktop\(\) \{\s*try \{\s*await killSidecar\(\)\s*\} finally \{\s*app\.relaunch\(\{ args: desktopRelaunchArgs\(process\.argv, pendingIncomingDeepLinks\) \}\)\s*app\.exit\(0\)\s*\}/u,
    )
    expect(index).toContain("createMainWindow(() => sidecarAuthorization)")
    expect(ipc).toContain("deps.translateProjectPaths")
    expect(server).toContain("closeInput: runtime.closeInput")
    expect(server).toContain("exited: runtime.exited")
  })
})
