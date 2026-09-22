import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createHash } from "node:crypto"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { runWslDesktopTransport, type WslDesktopIdentity } from "../../server/wsl-desktop-transport"

declare global {
  const BHARATCODE_WSL_COMPILED_SOURCE_SHA: string
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("desktop-sidecar-stdio", {
      type: "boolean",
      default: false,
      hidden: true,
    }),
  describe: "starts a headless BharatCode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    if (args.desktopSidecarStdio) {
      if (opts.hostname !== "127.0.0.1" || opts.port === 0 || opts.mdns)
        throw new Error("WSL Desktop stdio requires exact loopback and port")
      yield* Effect.promise(() =>
        runWslDesktopTransport({
          expectedHostname: "127.0.0.1",
          expectedPort: opts.port,
          input: process.stdin,
          identity: runtimeIdentity,
          listen: async ({ username, password, ...address }) => {
            const listener = await Server.listen({
              ...address,
              credentials: { username, password },
              cors: ["oc://renderer"],
            })
            return { stop: () => listener.stop(true) }
          },
          writeStdout: (record) =>
            new Promise<void>((resolve, reject) => {
              process.stdout.write(record, (error) => (error ? reject(error) : resolve()))
            }),
          writeStderr: (message) => {
            process.stderr.write(`${message}\n`)
          },
        }),
      )
      return
    }
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`BharatCode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})

async function runtimeIdentity(): Promise<WslDesktopIdentity> {
  const sourceSha = typeof BHARATCODE_WSL_COMPILED_SOURCE_SHA === "string" ? BHARATCODE_WSL_COMPILED_SOURCE_SHA : ""
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("WSL runtime build source identity is unavailable")
  const uid = process.getuid?.()
  if (!uid || !Number.isSafeInteger(uid)) throw new Error("WSL runtime requires a non-root UID")
  if (InstallationChannel !== "dev" && InstallationChannel !== "beta" && InstallationChannel !== "prod")
    throw new Error("WSL runtime channel is unavailable")
  return {
    type: "identity",
    source_sha: sourceSha,
    version: InstallationVersion,
    channel: InstallationChannel,
    executable_sha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(process.execPath).arrayBuffer()))
      .digest("hex"),
    uid,
  }
}
