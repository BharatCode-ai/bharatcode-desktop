import type { Writable } from "node:stream"

/** A GUI may outlive its launcher. Only a lost console pipe is disposable. */
export function guardConsolePipe(stream: Writable) {
  const write = stream.write
  let broken = false
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error
    broken = true
  })
  stream.write = function (
    ...args: [unknown, (BufferEncoding | ((error?: Error | null) => void))?, ((error?: Error | null) => void)?]
  ) {
    if (!broken) {
      try {
        return Reflect.apply(write, this, args)
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EPIPE") throw error
        broken = true
      }
    }
    // Keep subsequent console writes/callbacks non-blocking after pipe loss.
    // Do not log here: logging to the failed stream would recurse.
    const callback = typeof args[1] === "function" ? args[1] : args[2]
    if (callback) process.nextTick(callback)
    return true
  }
}
