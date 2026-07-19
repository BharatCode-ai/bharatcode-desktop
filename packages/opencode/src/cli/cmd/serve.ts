import { Effect } from "effect"
import { createHash } from "node:crypto"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Server } from "../../server/server"
import { runWslDesktopTransport, type WslDesktopIdentity } from "../../server/wsl-desktop-transport"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

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
    const opts = yield* resolveNetworkOptions(args)
    if (args.desktopSidecarStdio) {
      if (opts.hostname !== "127.0.0.1" || opts.mdns) throw new Error("WSL Desktop stdio requires exact loopback")
      yield* Effect.promise(() =>
        runWslDesktopTransport({
          expectedHostname: "127.0.0.1",
          expectedPort: opts.port,
          input: Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
          identity: runtimeIdentity,
          listen: async (credentials) => {
            const listener = await Server.listen({ ...credentials, cors: ["oc://renderer"] })
            return { stop: () => listener.stop(true) }
          },
          writeStdout: (record) =>
            new Promise<void>((resolve, reject) => {
              process.stdout.write(record, (error) => (error ? reject(error) : resolve()))
            }),
          writeStderr: (message) => process.stderr.write(`${message}\n`),
        }),
      )
      return
    }
    if (!process.env.BHARATCODE_SERVER_PASSWORD) {
      console.log("Warning: BHARATCODE_SERVER_PASSWORD is not set; server is unsecured.")
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
  return {
    type: "identity",
    source_sha: sourceSha,
    version: InstallationVersion,
    executable_sha256: createHash("sha256")
      .update(Buffer.from(await Bun.file(process.execPath).arrayBuffer()))
      .digest("hex"),
    uid,
  }
}
