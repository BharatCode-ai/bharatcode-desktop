import path from "node:path"
import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, lstatSync, openSync, renameSync } from "node:fs"
import { Cause, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { AuthLock } from "./lock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export const Store = Schema.Record(Schema.String, Info).annotate({ identifier: "AuthStore" })
export type Store = Schema.Schema.Type<typeof Store>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  operation: Schema.Literals(["read", "write", "lock"]),
  reason: Schema.Literals(["invalid", "permission", "unavailable"]),
  message: Schema.String,
}) {}

export type TransactionResult<A> =
  | { readonly action: "keep"; readonly result: A }
  | { readonly action: "set"; readonly info: Info; readonly result: A }
  | { readonly action: "remove"; readonly result: A }

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Store, AuthError>
  readonly transaction: <A, E, R>(
    key: string,
    callback: (current: Info | undefined) => Effect.Effect<TransactionResult<A>, E, R>,
  ) => Effect.Effect<A, AuthError | E, R>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export interface CredentialFileOps {
  readonly rename: (from: string, to: string) => void
  readonly syncDirectory: (directory: string) => void
}

export interface CredentialAccess {
  readonly verify: (input: {
    readonly file: string
    readonly parent: string
    readonly platform: NodeJS.Platform
    readonly operation: "read" | "write"
  }) => void
}

export interface LayerOptions {
  readonly onLockWait?: AuthLock.Options["onWait"]
  readonly acquireLock?: typeof AuthLock.acquire
  readonly credentialFileOps?: CredentialFileOps
  readonly credentialAccess?: CredentialAccess
  readonly platform?: NodeJS.Platform
  readonly onPrepared?: () => void
}

const decodeStore = Schema.decodeUnknownResult(Schema.fromJsonString(Store))
const validateStore = Schema.decodeUnknownResult(Store)
const encoder = new TextEncoder()
const defaultCredentialFileOps: CredentialFileOps = {
  rename: renameSync,
  syncDirectory(directory) {
    const handle = openSync(directory, "r")
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  },
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const global = yield* Global.Service
      const file = global.auth
      const parent = path.dirname(file)
      const lockDirectory = path.join(global.state, "locks")
      const lockFile = path.join(lockDirectory, "auth-store.sqlite")
      const credentialFileOps = options.credentialFileOps ?? defaultCredentialFileOps
      const platform = options.platform ?? process.platform
      const credentialAccess = options.credentialAccess ?? defaultCredentialAccess

      const verifyAccess = (operation: "read" | "write") =>
        Effect.try({
          try: () => credentialAccess.verify({ file, parent, platform, operation }),
          catch: () =>
            new AuthError({
              operation,
              reason: "permission",
              message:
                operation === "read"
                  ? "Credential store permissions could not be verified."
                  : "Credential store update permissions could not be verified.",
            }),
        })

      const all = Effect.fnUntraced(function* () {
        yield* verifyAccess("read")
        const content = yield* fsys.readFileString(file).pipe(
          Effect.map((value) => ({ found: true as const, value })),
          Effect.catchCause((cause): Effect.Effect<{ found: false }, AuthError> => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            return platformReason(error) === "NotFound"
              ? Effect.succeed({ found: false as const })
              : Effect.fail(
                  new AuthError({
                    operation: "read",
                    reason: platformReason(error) === "PermissionDenied" ? "permission" : "unavailable",
                    message: "Credential store could not be read.",
                  }),
                )
          }),
        )
        if (!content.found) return {}
        const decoded = decodeStore(content.value, { onExcessProperty: "error", errors: "all" })
        if (Result.isSuccess(decoded) && uniqueAliases(decoded.success)) return decoded.success
        return yield* new AuthError({
          operation: "read",
          reason: "invalid",
          message: "Credential store is invalid.",
        })
      })

      const persist = Effect.fnUntraced(function* (store: Store, commit: (temp: string) => void) {
        const checked = validateStore(store, { onExcessProperty: "error", errors: "all" })
        if (Result.isFailure(checked)) {
          return yield* new AuthError({
            operation: "write",
            reason: "invalid",
            message: "Credential store update is invalid.",
          })
        }
        if (!uniqueAliases(checked.success)) {
          return yield* new AuthError({
            operation: "write",
            reason: "invalid",
            message: "Credential store update is invalid.",
          })
        }

        yield* safeWrite(fsys.makeDirectory(parent, { recursive: true, mode: 0o700 }))
        if (platform !== "win32") {
          yield* safeWrite(fsys.chmod(parent, 0o700))
        }
        yield* verifyAccess("write")

        const writeTemp = (attempt = 0): Effect.Effect<string, unknown> =>
          Effect.suspend(() => {
            const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`)
            let owned = false
            return Effect.scoped(
              Effect.gen(function* () {
                // Apply 0600 at exclusive creation so secret bytes are never observable through a broader temporary file.
                const handle = yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const opened = yield* fsys.open(temp, { flag: "wx", mode: 0o600 })
                    owned = true
                    return opened
                  }),
                )
                yield* handle.writeAll(encoder.encode(JSON.stringify(checked.success, null, 2)))
                yield* handle.sync
                return temp
              }),
            ).pipe(
              Effect.onError(() => (owned ? fsys.remove(temp, { force: true }).pipe(Effect.ignoreCause) : Effect.void)),
              Effect.catchIf(
                (error) => !owned && platformReason(error) === "AlreadyExists" && attempt < 8,
                () => writeTemp(attempt + 1),
              ),
            )
          })

        const temp = yield* safeWrite(writeTemp())
        let activated = false
        yield* Effect.gen(function* () {
          yield* Effect.try({
            try: () => options.onPrepared?.(),
            catch: () => writeError(undefined),
          })
          // This is the final cooperative-cancellation boundary. The following commit callback is one
          // synchronous JavaScript turn: rename, best-effort durability, lock release, and result handoff.
          yield* Effect.yieldNow
          yield* Effect.try({
            try: () => {
              commit(temp)
              activated = true
            },
            catch: () => writeError(undefined),
          })
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              activated ? Effect.void : fsys.remove(temp, { force: true }).pipe(Effect.ignoreCause),
            ),
          ),
        )
      })

      const acquire = Effect.gen(function* () {
        yield* fsys
          .makeDirectory(lockDirectory, { recursive: true, mode: 0o700 })
          .pipe(
            Effect.catchCause(
              (cause): Effect.Effect<never, AuthError> =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(lockError("acquired")),
            ),
          )
        if (process.platform !== "win32") {
          yield* fsys
            .chmod(lockDirectory, 0o700)
            .pipe(
              Effect.catchCause(
                (cause): Effect.Effect<never, AuthError> =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause as Cause.Cause<never>)
                    : Effect.fail(lockError("acquired")),
              ),
            )
        }
        return yield* Effect.callback<AuthLock.Lease, AuthError>((resume, signal) => {
          const pending = Promise.resolve().then(() =>
            (options.acquireLock ?? AuthLock.acquire)(lockFile, {
              signal,
              onWait: options.onLockWait,
            }),
          )
          pending.then(
            (lease) => resume(Effect.succeed(lease)),
            () => resume(Effect.fail(lockError("acquired"))),
          )
          return Effect.tryPromise({
            try: async () => {
              if (!releaseLease(await pending)) throw lockError("released")
            },
            catch: () => lockError("released"),
          }).pipe(Effect.ignoreCause)
        })
      })

      const release = (lease: AuthLock.Lease) =>
        Effect.suspend(() => (releaseLease(lease) ? Effect.void : Effect.fail(lockError("released"))))

      const transaction: Interface["transaction"] = (key, callback) =>
        Effect.suspend(() => {
          let committed = false
          let released = false
          return Effect.acquireUseRelease(
            Effect.interruptible(acquire),
            (lease) =>
              Effect.gen(function* () {
                // Re-read only after acquiring the process-wide store lock and retain it across the asynchronous callback.
                const normalized = normalize(key)
                const store = yield* all()
                const matched = Object.keys(store).find((candidate) => normalize(candidate) === normalized)
                const next = yield* callback(matched === undefined ? undefined : store[matched])
                if (next.action === "keep") return next.result

                const updated = Object.assign(Object.create(null), store) as Record<string, Info>
                for (const candidate of Object.keys(updated)) {
                  if (normalize(candidate) === normalized) delete updated[candidate]
                }
                if (next.action === "set") {
                  Object.defineProperty(updated, normalized, {
                    value: next.info,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                  })
                }
                if (next.action !== "set" && next.action !== "remove") {
                  return yield* new AuthError({
                    operation: "write",
                    reason: "invalid",
                    message: "Credential store transaction is invalid.",
                  })
                }
                yield* persist(updated, (temp) => {
                  credentialFileOps.rename(temp, file)
                  committed = true
                  try {
                    credentialFileOps.syncDirectory(parent)
                  } catch {
                    // The replacement is already active. A durability-tail defect cannot make the write fail.
                  }
                  released = releaseLease(lease)
                })
                return next.result
              }),
            (lease) => {
              if (released) return Effect.void
              const cleanup = release(lease)
              return committed ? cleanup.pipe(Effect.ignoreCause) : cleanup
            },
          )
        })

      const get = Effect.fnUntraced(function* (providerID: string) {
        const store = yield* all()
        const normalized = normalize(providerID)
        const matched = Object.keys(store).find((candidate) => normalize(candidate) === normalized)
        return matched === undefined ? undefined : store[matched]
      })

      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        yield* transaction(key, () => Effect.succeed({ action: "set", info, result: undefined }))
      })

      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        yield* transaction(key, () => Effect.succeed({ action: "remove", result: undefined }))
      })

      return Service.of({ get, all, transaction, set, remove })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Global.defaultLayer))

function normalize(key: string) {
  return key.replace(/\/+$/, "")
}

function uniqueAliases(store: Store) {
  const keys = Object.keys(store).map(normalize)
  return new Set(keys).size === keys.length
}

function releaseLease(lease: AuthLock.Lease, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      lease.release()
      return true
    } catch {
      // The native lease is idempotent and retains enough state to retry only unfinished cleanup.
    }
  }
  return false
}

function safeWrite<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AuthError, R> {
  return effect.pipe(
    Effect.catchCause((cause): Effect.Effect<never, AuthError> => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
      return Effect.fail(writeError(Option.getOrUndefined(Cause.findErrorOption(cause))))
    }),
  )
}

function platformReason(error: unknown) {
  if (typeof error !== "object" || error === null || !("reason" in error)) return
  const reason = error.reason
  if (typeof reason !== "object" || reason === null || !("_tag" in reason)) return
  return reason._tag
}

function writeError(error: unknown) {
  return new AuthError({
    operation: "write",
    reason: platformReason(error) === "PermissionDenied" ? "permission" : "unavailable",
    message: "Credential store update failed.",
  })
}

function lockError(action: "acquired" | "released") {
  return new AuthError({
    operation: "lock",
    reason: "unavailable",
    message: `Credential store lock could not be ${action}.`,
  })
}

const defaultCredentialAccess: CredentialAccess = {
  verify({ file, parent, platform, operation }) {
    if (platform === "win32") throw new Error("A current-user credential ACL verifier is required.")
    const uid = process.getuid?.()
    if (uid === undefined) throw new Error("Credential ownership is unverifiable.")

    const credential = lstatOrMissing(file)
    if (!credential && operation === "read") return

    const directory = lstatOrMissing(parent)
    if (directory) {
      if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("Credential directory is unsafe.")
      if (directory.uid !== uid || (directory.mode & 0o077) !== 0) throw new Error("Credential directory is shared.")
    }

    if (!credential) return
    if (credential.isSymbolicLink() || !credential.isFile() || credential.nlink !== 1) {
      throw new Error("Credential file is unsafe.")
    }
    if (credential.uid !== uid || (credential.mode & 0o077) !== 0) throw new Error("Credential file is shared.")
  },
}

function lstatOrMissing(pathname: string) {
  try {
    return lstatSync(pathname)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export * as Auth from "."
