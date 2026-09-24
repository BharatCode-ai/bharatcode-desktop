import { homedir, tmpdir } from "node:os"
import { stat } from "node:fs/promises"
import { Effect } from "effect"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { importPreviousChats } from "./chat-import"

const port = (process as typeof process & { parentPort: { postMessage(value: unknown): void } }).parentPort

async function run() {
  // Custom databases are deliberate destinations, not upgrade targets.
  if (process.env.OPENCODE_DB) return { imported: 0, skipped: 0 }
  const channel = StoragePaths.normalizeChannel(process.env.BHARATCODE_CHANNEL ?? import.meta.env.OPENCODE_CHANNEL)
  const input = {
    channel,
    platform: process.platform,
    home: process.env.OPENCODE_TEST_HOME ?? homedir(),
    temp: tmpdir(),
    env: process.env,
  }
  const source = StoragePaths.resolve({
    ...input,
    name: channel === "prod" ? "bharatcode" : `bharatcode-${channel}`,
  }).database
  const destination = StoragePaths.resolve(input).database
  if (source.toLowerCase() === destination.toLowerCase() && process.platform === "win32")
    return { imported: 0, skipped: 0 }
  if (source === destination) return { imported: 0, skipped: 0 }
  const exists = await stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!exists) return { imported: 0, skipped: 0 }
  // Loaded only in this background utility process, after server readiness.
  const { Database } = await import("virtual:opencode-server")
  await Effect.runPromise(Database.Service.pipe(Effect.provide(Database.layerFromPath(destination))))
  return importPreviousChats(source, destination)
}

run()
  .then(
    (result) => {
      port.postMessage({ state: "complete", ...result })
      process.exitCode = 0
    },
    () => {
      port.postMessage({ state: "failed", imported: 0, skipped: 0 })
      process.exitCode = 1
    },
  )
  .finally(() => setImmediate(() => process.exit(process.exitCode ?? 0)))
