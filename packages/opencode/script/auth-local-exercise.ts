/**
 * Run from packages/opencode, with the fixture CA supplied at process startup:
 * NODE_EXTRA_CA_CERTS=/path/to/local-ca.pem BHARATCODE_AUTH_URL=https://auth.localhost:47900 \
 *   bun run script/auth-local-exercise.ts --flow=cli
 *
 * Read the JSON "authorize" event and open its URL in the fixture's browser.
 * CLI waits for its real http://127.0.0.1:27182/callback listener. For
 * --flow=desktop, feed the resulting bharatcode://auth/callback?... URL as one
 * stdin line. This drives the shared native service, not the Electron GUI.
 * Successful completion checks UserInfo, persisted storage, and forced refresh.
 * All state is disposable; no existing credentials/config are read or imported.
 * Add --fixture=/absolute/path/env.json to approve consent automatically using
 * ONLY a synthetic fixture's password/authOrigin/userId. Set
 * BHARATCODE_AUTH_FIXTURE_EMAIL for a fixture email other than
 * auth-test@rehearsal.invalid. The fixture and all token values stay out of logs.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { Effect, Layer } from "effect"
import { BharatCodeAuth } from "@opencode-ai/core/bharatcode-auth"
import { approveLocalFixture } from "./auth-local-fixture"

const flow = Bun.argv[2]
const fixtureFile = Bun.argv[3]?.startsWith("--fixture=") ? Bun.argv[3].slice(10) : undefined
if (
  (Bun.argv.length !== 3 && !(Bun.argv.length === 4 && fixtureFile)) ||
  (flow !== "--flow=cli" && flow !== "--flow=desktop")
) {
  throw new Error("Usage: bun run script/auth-local-exercise.ts --flow=cli|desktop [--fixture=/path/env.json]")
}
if (process.env.BHARATCODE_AUTH_URL === undefined && process.env.OPENCODE_AUTH_URL === undefined) {
  throw new Error("Set BHARATCODE_AUTH_URL to the local Auth fixture before running this harness.")
}
const issuer = BharatCodeAuth.issuer()
const host = new URL(issuer).hostname
if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && !host.endsWith(".localhost")) {
  throw new Error("This harness only accepts a loopback or .localhost Auth fixture, never production.")
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  throw new Error("TLS verification must stay enabled. Supply the fixture CA using NODE_EXTRA_CA_CERTS.")
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bharatcode-local-auth-"))
// Global paths are evaluated at import time: isolate them before loading Auth.
Object.assign(process.env, {
  OPENCODE_TEST_HOME: root,
  BHARATCODE_CHANNEL: "test",
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  APPDATA: path.join(root, "roaming"),
  LOCALAPPDATA: path.join(root, "local"),
  OPENCODE_DISABLE_MODELS_FETCH: "true",
})

function emit(value: unknown) {
  console.log(JSON.stringify(value))
}

try {
  const { Auth } = await import("../src/auth")
  const { BharatCodeAccount } = await import("../src/bharatcode/account")
  const { BharatCodeLoopback } = await import("../src/bharatcode/loopback")
  const layer = BharatCodeAccount.layerWith({ env: { BHARATCODE_AUTH_URL: issuer } }).pipe(
    Layer.provideMerge(Auth.defaultLayer),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* BharatCodeAccount.Service
      const auth = yield* Auth.Service
      const redirectUri =
        flow === "--flow=cli" ? BharatCodeAccount.CLI_REDIRECT_URI : BharatCodeAccount.DESKTOP_REDIRECT_URI
      const authorization = yield* account.beginAuthorization({ redirectUri })
      yield* Effect.addFinalizer(() => account.cancelAuthorization(authorization.state))
      const listener =
        flow === "--flow=cli"
          ? yield* Effect.acquireRelease(
              Effect.promise(() => BharatCodeLoopback.start({ expectedState: authorization.state })),
              (session) => Effect.sync(session.close),
            )
          : undefined
      // Attach a rejection handler immediately while automated consent runs.
      void listener?.callback.catch(() => undefined)
      emit({
        event: "authorize",
        flow: flow.slice(7),
        redirectUri,
        ...(fixtureFile ? { issuer } : authorization),
      })
      const callbackUrl = yield* Effect.gen(function* () {
        if (fixtureFile) {
          const callback = yield* Effect.promise(() =>
            approveLocalFixture({ issuer, url: authorization.url, file: fixtureFile, redirectUri }),
          )
          if (!listener) return callback
          const received = yield* Effect.promise(() => fetch(callback, { redirect: "manual" }))
          if (!received.ok) throw new Error("CLI loopback did not accept the fixture callback.")
          yield* Effect.promise(() => received.text())
        }
        if (listener) return yield* Effect.promise(() => listener.callback)
        const input = yield* Effect.acquireRelease(
          Effect.sync(() => createInterface({ input: process.stdin })),
          (input) => Effect.sync(() => input.close()),
        )
        const line = yield* Effect.promise(() => input[Symbol.asyncIterator]().next())
        if (line.done || !line.value) throw new Error("Expected a Desktop callback URL on stdin.")
        return line.value
      })
      yield* account.completeAuthorization(callbackUrl)
      const signedIn = yield* account.status()
      if (signedIn.state !== "signed-in") throw new Error("The native account did not reach signed-in status.")
      const before = yield* auth.get(BharatCodeAccount.PROVIDER_ID)
      if (before?.type !== "oauth" || before.accountId !== signedIn.accountID) {
        throw new Error("The native account session was not persisted correctly.")
      }
      emit({ event: "signed-in", state: signedIn.state, expiresAt: signedIn.expiresAt, persisted: true })
      yield* account.accessToken({ forceRefresh: true })
      const refreshed = yield* account.status()
      const after = yield* auth.get(BharatCodeAccount.PROVIDER_ID)
      if (refreshed.state !== "signed-in" || after?.type !== "oauth" || after.accountId !== before.accountId) {
        throw new Error("The refreshed native session did not preserve its account identity.")
      }
      emit({
        event: "refreshed",
        state: refreshed.state,
        expiresAt: refreshed.expiresAt,
        refreshTokenRotated: after.refresh !== before.refresh,
        persisted: true,
      })
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
} catch (error) {
  emit({ event: "failed", message: error instanceof Error ? error.message : "Local auth exercise failed." })
  process.exitCode = 1
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
