import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import open from "open"
import type { ChildProcess } from "node:child_process"
import { openWindowsHostUrl } from "@opencode-ai/core/util/windows-host-browser"

export interface Interface {
  readonly open: (url: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpBrowser") {}

export function make(
  options: {
    platform?: string
    launchWindows?: (url: string) => Promise<void>
    launch?: (url: string) => Promise<ChildProcess>
  } = {},
): Interface {
  const fail = () => new Error("Could not open MCP authorization. Retry from the MCP controls.")
  return {
    open: Effect.fn("McpBrowser.open")(function* (url: string) {
      const parsed = URL.canParse(url) ? new URL(url) : undefined
      if (!parsed || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
        return yield* Effect.fail(fail())
      if ((options.platform ?? process.platform) === "win32") {
        return yield* Effect.tryPromise({
          try: () => (options.launchWindows ?? openWindowsHostUrl)(url),
          catch: fail,
        })
      }
      const subprocess = yield* Effect.tryPromise({
        try: () => (options.launch ?? open)(url),
        catch: fail,
      })
      yield* Effect.callback<void, Error>((resume) => {
        let finished = false
        const cleanup = () => {
          clearTimeout(timer)
          subprocess.off("exit", onExit)
        }
        const finish = (error = false) => {
          if (finished) return
          finished = true
          cleanup()
          resume(error ? Effect.fail(fail()) : Effect.void)
        }
        const onError = () => finish(true)
        const onExit = (code: number | null) => finish(code !== null && code !== 0)
        const timer = setTimeout(() => finish(), 500)
        // The detached launcher can report a late spawn error after the short
        // observation window or cancellation. Absorb it until the child closes.
        subprocess.on("error", onError)
        subprocess.once("close", () => subprocess.off("error", onError))
        subprocess.once("exit", onExit)
        return Effect.sync(() => {
          finished = true
          cleanup()
        })
      })
    }),
  }
}

const layer = Layer.succeed(Service, Service.of(make()))

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as McpBrowser from "./browser"
