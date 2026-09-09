import { afterEach, describe, expect, test } from "bun:test"
import { renameSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, Tracer } from "effect"
import type * as Scope from "effect/Scope"
import * as PlatformError from "effect/PlatformError"
import { open as openAuthLockDatabase } from "#auth-lock-db"
import { Auth } from "../../src/auth"
import { AuthLock } from "../../src/auth/lock"
import { tmpdir } from "../fixture/fixture"

const workerFile = path.join(import.meta.dir, "../fixture/auth-store-worker.ts")
const packageRoot = path.resolve(import.meta.dir, "../..")
const originalAuthContent = {
  opencode: process.env.OPENCODE_AUTH_CONTENT,
  bharatcode: process.env.BHARATCODE_AUTH_CONTENT,
}

function completeGlobal(root: string): Global.Interface {
  const base = path.join(root, "bharatcode-test")
  const data = path.join(base, "data")
  const cache = path.join(base, "cache")
  return {
    channel: "test",
    home: root,
    data,
    cache,
    config: path.join(base, "config"),
    state: path.join(base, "state"),
    recovery: path.join(base, "state"),
    tmp: path.join(base, "tmp"),
    bin: path.join(cache, "bin"),
    log: path.join(base, "log"),
    repos: path.join(data, "repos"),
    storage: path.join(data, "storage"),
    auth: path.join(data, "auth.json"),
    database: path.join(data, "bharatcode.db"),
  }
}

type AuthLayerOptions = Auth.LayerOptions

function authLayer(
  root: string,
  filesystem: Layer.Layer<AppFileSystem.Service> = AppFileSystem.defaultLayer,
  options?: AuthLayerOptions,
) {
  const auth = options ? Auth.layerWith(options) : Auth.layer
  return Layer.fresh(auth.pipe(Layer.provide(filesystem), Layer.provide(Global.layerWith(completeGlobal(root)))))
}

function runAuth<A, E>(
  root: string,
  effect: Effect.Effect<A, E, Auth.Service | Scope.Scope>,
  filesystem?: Layer.Layer<AppFileSystem.Service>,
  options?: AuthLayerOptions,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(authLayer(root, filesystem, options)), Effect.scoped))
}

function wrappedFilesystem(
  wrap: (filesystem: AppFileSystem.Interface) => AppFileSystem.Interface,
): Layer.Layer<AppFileSystem.Service> {
  return Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      return AppFileSystem.Service.of(wrap(yield* AppFileSystem.Service))
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
}

function api(key: string): Auth.Api {
  return new Auth.Api({ type: "api", key })
}

async function seedPrivateCredential(root: string, content: string, fileMode = 0o600, directoryMode = 0o700) {
  const paths = completeGlobal(root)
  await fs.mkdir(paths.data, { recursive: true, mode: directoryMode })
  await fs.chmod(paths.data, directoryMode)
  await fs.writeFile(paths.auth, content, { mode: fileMode })
  await fs.chmod(paths.auth, fileMode)
}

async function expectAuthError<A, E>(effect: Promise<Exit.Exit<A, E>>) {
  const exit = await effect
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected credential-store failure")
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(Auth.AuthError)
  return { error: error as Auth.AuthError, cause: exit.cause }
}

async function waitForFiles(files: string[], timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await Promise.all(files.map((file) => Bun.file(file).exists()))).every(Boolean)) return
    await Bun.sleep(10)
  }
  throw new Error(`readiness barrier timed out (${files.map((file) => path.basename(file)).join(", ")})`)
}

type WorkerInput =
  | { mode: "set"; root: string; ready: string; gate: string; key: string; value: string }
  | { mode: "remove"; root: string; ready: string; gate: string; key: string }
  | { mode: "holder"; root: string; ready: string; gate: string; key: string }
  | { mode: "contender"; root: string; ready: string; seen: string; key: string }

function spawnWorker(input: WorkerInput) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "OPENCODE_AUTH_CONTENT" && entry[0] !== "BHARATCODE_AUTH_CONTENT",
    ),
  )
  return Bun.spawn([process.execPath, workerFile, JSON.stringify(input)], {
    cwd: packageRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function expectWorkers(worker: Array<ReturnType<typeof spawnWorker>>) {
  const results = await Promise.all(
    worker.map(async (process) => ({
      code: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })),
  )
  expect(results).toEqual(results.map(() => ({ code: 0, stdout: "", stderr: "" })))
}

async function expectWorkerWithin(worker: ReturnType<typeof spawnWorker>, timeoutMs = 2_000) {
  const timeout = Bun.sleep(timeoutMs).then(() => "timeout" as const)
  const exited = worker.exited.then((code) => ({ code }) as const)
  const result = await Promise.race([exited, timeout])
  if (result === "timeout") {
    worker.kill("SIGKILL")
    await worker.exited
    throw new Error("worker did not exit before the cancellation deadline")
  }
  const stdout = await new Response(worker.stdout).text()
  const stderr = await new Response(worker.stderr).text()
  expect({ code: result.code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
}

function captureTelemetry() {
  const spans: Tracer.NativeSpan[] = []
  const logs: Logger.Options<unknown>[] = []
  return {
    spans,
    logs,
    tracer: Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    }),
    logger: Logger.make((options) => {
      logs.push(options)
    }),
  }
}

function renderTelemetry(input: ReturnType<typeof captureTelemetry>) {
  return [
    ...input.spans.map((span) => {
      if (span.status._tag === "Started") return span.name
      return [
        span.name,
        Exit.isFailure(span.status.exit) ? Cause.pretty(span.status.exit.cause) : String(span.status.exit.value),
      ].join(":")
    }),
    ...input.logs.map((log) => [String(log.message), Cause.pretty(log.cause)].join(":")),
  ].join("\n")
}

afterEach(() => {
  if (originalAuthContent.opencode === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent.opencode
  if (originalAuthContent.bharatcode === undefined) delete process.env.BHARATCODE_AUTH_CONTENT
  else process.env.BHARATCODE_AUTH_CONTENT = originalAuthContent.bharatcode
})

describe("Auth secure native store", () => {
  test("a missing yielded channel auth file is an empty store", async () => {
    await using tmp = await tmpdir()
    expect(
      await runAuth(
        tmp.path,
        Auth.Service.use((auth) => auth.all()),
      ),
    ).toEqual({})
    expect(await Bun.file(completeGlobal(tmp.path).auth).exists()).toBe(false)
  })

  test("rejects non-owner-only credential directories and files before decoding", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const content = JSON.stringify({ bharatcode: { type: "api", key: "must-not-be-read" } })

    await seedPrivateCredential(tmp.path, content, 0o600, 0o755)
    const directoryFailure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
    expect(directoryFailure.error).toMatchObject({ operation: "read", reason: "permission" })

    await fs.chmod(completeGlobal(tmp.path).data, 0o700)
    await fs.chmod(completeGlobal(tmp.path).auth, 0o644)
    const fileFailure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
    expect(fileFailure.error).toMatchObject({ operation: "read", reason: "permission" })
  })

  test("rejects a symlinked credential file before reading target bytes", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const paths = completeGlobal(tmp.path)
    await fs.mkdir(paths.data, { recursive: true, mode: 0o700 })
    const target = path.join(tmp.path, "attacker-owned.json")
    await fs.writeFile(target, JSON.stringify({ bharatcode: { type: "api", key: "symlink-secret" } }), {
      mode: 0o600,
    })
    await fs.symlink(target, paths.auth)

    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
    expect(failure.error).toMatchObject({ operation: "read", reason: "permission" })
    expect(JSON.stringify(failure.cause)).not.toContain("symlink-secret")
  })

  test("exercises the current-user ACL verifier for a Windows fixture", async () => {
    await using tmp = await tmpdir()
    await seedPrivateCredential(tmp.path, JSON.stringify({ bharatcode: { type: "api", key: "windows-private" } }))
    const unavailable = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
        undefined,
        { platform: "win32" },
      ),
    )
    expect(unavailable.error).toMatchObject({ operation: "read", reason: "permission" })

    const verified: string[] = []
    const result = await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.all()),
      undefined,
      {
        credentialAccess: {
          verify(input) {
            expect(input.platform).toBe("win32")
            verified.push(input.file)
          },
        },
        platform: "win32",
      },
    )

    expect(result.bharatcode).toMatchObject({ type: "api", key: "windows-private" })
    expect(verified).toEqual([completeGlobal(tmp.path).auth])
  })

  test("malformed JSON is a typed store error, not signed out", async () => {
    await using tmp = await tmpdir()
    await seedPrivateCredential(tmp.path, "{not-json")
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
    expect(failure.error).toMatchObject({ operation: "read", reason: "invalid" })
  })

  test("one invalid entry rejects the complete store", async () => {
    await using tmp = await tmpdir()
    await seedPrivateCredential(
      tmp.path,
      JSON.stringify({ valid: { type: "api", key: "synthetic" }, invalid: { type: "api", key: 42 } }),
    )
    await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
  })

  test("unknown credential fields are rejected instead of stripped", async () => {
    await using tmp = await tmpdir()
    await seedPrivateCredential(
      tmp.path,
      JSON.stringify({ provider: { type: "api", key: "synthetic", leaked: "must-not-be-accepted" } }),
    )
    await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
  })

  test("read permission denial remains a typed store failure", async () => {
    await using tmp = await tmpdir()
    const auth = completeGlobal(tmp.path).auth
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      readFileString: (file, encoding) =>
        file === auth
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
              }),
            )
          : base.readFileString(file, encoding),
    }))
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((service) => Effect.exit(service.all())),
        filesystem,
      ),
    )
    expect(failure.error).toMatchObject({ operation: "read", reason: "permission" })
  })

  test("read defects become safe typed failures without retaining native content", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      readFileString: (file, encoding) =>
        file === roots.auth
          ? Effect.die("read-defect-seeded-secret:" + roots.auth)
          : base.readFileString(file, encoding),
    }))
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((service) => Effect.exit(service.all())),
        filesystem,
      ),
    )
    const rendered = [String(failure.error), JSON.stringify(failure.cause), Cause.pretty(failure.cause)].join("\n")
    expect(failure.error).toMatchObject({ operation: "read", reason: "unavailable" })
    expect(rendered).not.toContain("read-defect-seeded-secret")
    expect(rendered).not.toContain(roots.auth)
  })

  test("auth-content environment variables are inert", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ injected: { type: "api", key: "env-secret" } })
    process.env.BHARATCODE_AUTH_CONTENT = JSON.stringify({ injected: { type: "api", key: "env-secret" } })
    expect(
      await runAuth(
        tmp.path,
        Auth.Service.use((auth) => auth.all()),
      ),
    ).toEqual({})
  })

  test("set normalizes aliases and remove deletes every trailing-slash alias", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          yield* auth.set("https://example.com///", api("old"))
          yield* auth.set("https://example.com", api("new"))
          expect(Object.keys(yield* auth.all())).toEqual(["https://example.com"])
          expect(yield* auth.get("https://example.com/")).toEqual(api("new"))
          yield* auth.remove("https://example.com//")
          expect(yield* auth.all()).toEqual({})
        }),
      ),
    )
  })

  test("provider keys that overlap Object prototype names round-trip as own records", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          yield* auth.set("__proto__", api("prototype-safe"))
          yield* auth.set("constructor", api("constructor-safe"))

          const store = yield* auth.all()
          expect(Object.hasOwn(store, "__proto__")).toBe(true)
          expect(Object.hasOwn(store, "constructor")).toBe(true)
          expect(store.__proto__).toEqual(api("prototype-safe"))
          expect(Reflect.get(store, "constructor")).toEqual(api("constructor-safe"))
          expect(yield* auth.get("__proto__")).toEqual(api("prototype-safe"))
        }),
      ),
    )

    const persisted = JSON.parse(await fs.readFile(completeGlobal(tmp.path).auth, "utf8"))
    expect(Object.hasOwn(persisted, "__proto__")).toBe(true)
    expect(persisted.__proto__).toEqual({ type: "api", key: "prototype-safe" })
  })

  test("duplicate normalized aliases invalidate the whole store before any record or callback is exposed", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    await seedPrivateCredential(
      tmp.path,
      JSON.stringify({ provider: { type: "api", key: "first" }, "provider/": { type: "api", key: "second" } }),
    )

    const all = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
    expect(all.error).toMatchObject({ operation: "read", reason: "invalid" })
    const get = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.get("provider"))),
      ),
    )
    expect(get.error).toMatchObject({ operation: "read", reason: "invalid" })

    let entered = false
    const transaction = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) =>
          Effect.exit(
            auth.transaction("provider", () => {
              entered = true
              return Effect.succeed({ action: "keep" as const, result: undefined })
            }),
          ),
        ),
      ),
    )
    expect(transaction.error).toMatchObject({ operation: "read", reason: "invalid" })
    expect(entered).toBe(false)
  })

  test("first creation hardens the directory before exclusive 0600 temp creation", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const events: Array<{ operation: string; file: string; mode?: number; flag?: string }> = []
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      makeDirectory: (file, options) => {
        events.push({ operation: "mkdir", file, mode: options?.mode })
        return base.makeDirectory(file, options)
      },
      chmod: (file, mode) => {
        events.push({ operation: "chmod", file, mode })
        return base.chmod(file, mode)
      },
      open: (file, options) => {
        events.push({ operation: "open", file, mode: options?.mode, flag: options?.flag })
        return base.open(file, options)
      },
      writeFile: (file, data, options) => {
        events.push({ operation: "writeFile", file, mode: options?.mode, flag: options?.flag })
        return base.writeFile(file, data, options)
      },
      writeFileString: (file, data, options) => {
        events.push({ operation: "writeFileString", file, mode: options?.mode, flag: options?.flag })
        return base.writeFileString(file, data, options)
      },
    }))

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("synthetic"))),
      filesystem,
      {
        credentialFileOps: {
          rename(from, to) {
            events.push({ operation: "rename", file: `${from}->${to}` })
            renameSync(from, to)
          },
          syncDirectory() {},
        },
      },
    )

    expect((await fs.stat(roots.data)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(roots.auth)).mode & 0o777).toBe(0o600)
    const harden = events.findIndex((event) => event.operation === "chmod" && event.file === roots.data)
    const temp = events.findIndex(
      (event) => event.operation === "open" && event.file !== roots.data && event.flag === "wx",
    )
    const activate = events.findIndex((event) => event.operation === "rename" && event.file.endsWith(`->${roots.auth}`))
    expect(harden).toBeGreaterThanOrEqual(0)
    expect(temp).toBeGreaterThan(harden)
    expect(events[temp]).toMatchObject({ mode: 0o600, flag: "wx" })
    expect(activate).toBeGreaterThan(temp)
    expect(events.some((event) => event.file === roots.auth && event.operation.startsWith("write"))).toBe(false)
  })

  test("failure before activation preserves prior bytes and removes owned temp residue", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("before"))),
    )
    const before = await fs.readFile(roots.auth)
    await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.set("provider", api("after")))),
        undefined,
        {
          credentialFileOps: {
            rename() {
              throw new Error("synthetic activation failure")
            },
            syncDirectory() {},
          },
        },
      ),
    )
    expect(await fs.readFile(roots.auth)).toEqual(before)
    expect((await fs.readdir(roots.data)).filter((file) => file !== "auth.json")).toEqual([])
  })

  test("exclusive temp-name collisions are retried without deleting foreign bytes", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    let collision: string | undefined
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      open: (file, options) => {
        if (!collision && file !== roots.data && options?.flag === "wx") {
          collision = file
          return Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(file, "foreign-temp-owner"))
            return yield* Effect.fail(
              PlatformError.systemError({ _tag: "AlreadyExists", module: "FileSystem", method: "open" }),
            )
          })
        }
        return base.open(file, options)
      },
    }))

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("synthetic"))),
      filesystem,
    )

    expect(collision).toBeDefined()
    expect(await fs.readFile(collision!, "utf8")).toBe("foreign-temp-owner")
    expect(JSON.parse(await fs.readFile(roots.auth, "utf8"))).toEqual({
      provider: { type: "api", key: "synthetic" },
    })
  })

  test("interruption after exclusive temp creation removes the owned residue before returning", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    let signalOpened!: () => void
    const opened = new Promise<void>((resolve) => {
      signalOpened = resolve
    })
    let finishOpen!: () => void
    const gate = new Promise<void>((resolve) => {
      finishOpen = resolve
    })
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      open: (file, options) =>
        options?.flag === "wx"
          ? Effect.gen(function* () {
              const handle = yield* base.open(file, options)
              signalOpened()
              yield* Effect.promise(() => gate)
              return handle
            })
          : base.open(file, options),
    }))

    const exit = await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const fiber = yield* auth.set("provider", api("synthetic")).pipe(Effect.forkScoped)
          yield* Effect.promise(() => opened)
          fiber.interruptUnsafe()
          finishOpen()
          return yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
        }),
      ),
      filesystem,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(await Bun.file(roots.auth).exists()).toBe(false)
    expect((await fs.readdir(roots.data)).filter((file) => file !== "auth.json")).toEqual([])
  })

  test("scoped temp-handle close defects become safe typed errors and clean only the owned temp", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      open: (file, options) =>
        base
          .open(file, options)
          .pipe(
            Effect.flatMap((handle) =>
              options?.flag === "wx"
                ? Effect.acquireRelease(Effect.succeed(handle), () =>
                    Effect.die("close-defect-seeded-secret-and-path:" + roots.auth),
                  )
                : Effect.succeed(handle),
            ),
          ),
    }))

    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.set("provider", api("synthetic")))),
        filesystem,
      ),
    )
    const rendered = [String(failure.error), JSON.stringify(failure.cause), Cause.pretty(failure.cause)].join("\n")
    expect(rendered).not.toContain("close-defect-seeded-secret")
    expect(rendered).not.toContain(roots.auth)
    expect(await Bun.file(roots.auth).exists()).toBe(false)
    expect((await fs.readdir(roots.data)).filter((file) => file !== "auth.json")).toEqual([])
  })

  test("post-activation directory sync and close defects cannot turn a committed write into failure", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("committed"))),
      undefined,
      {
        credentialFileOps: {
          rename: renameSync,
          syncDirectory() {
            throw new Error("directory-sync-defect-seeded-secret:" + roots.auth)
          },
        },
      },
    )
    expect(JSON.parse(await fs.readFile(roots.auth, "utf8"))).toEqual({
      provider: { type: "api", key: "committed" },
    })
  })

  test("activation, durability, and lock release form one synchronous commit tail", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    let active: Fiber.Fiber<unknown, unknown> | undefined
    let activationCalls = 0
    let releases = 0
    const options = {
      acquireLock: async () => ({
        release() {
          releases += 1
        },
      }),
      credentialFileOps: {
        rename(from: string, to: string) {
          activationCalls += 1
          renameSync(from, to)
          queueMicrotask(() => active?.interruptUnsafe())
        },
        syncDirectory() {},
      },
    } as unknown as AuthLayerOptions

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const fiber = yield* auth.set("provider", api("committed")).pipe(Effect.forkScoped)
          active = fiber
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      ),
      undefined,
      options,
    )

    expect(activationCalls).toBe(1)
    expect(releases).toBe(1)
    expect(JSON.parse(await fs.readFile(roots.auth, "utf8"))).toEqual({
      provider: { type: "api", key: "committed" },
    })
  })

  test("interruption at the final prepare checkpoint preserves old bytes and never activates", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("before"))),
    )
    const before = await fs.readFile(roots.auth)
    let active: Fiber.Fiber<unknown, unknown> | undefined
    let activationCalls = 0

    const exit = await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const fiber = yield* auth.set("provider", api("after")).pipe(Effect.forkScoped)
          active = fiber
          return yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
        }),
      ),
      undefined,
      {
        onPrepared() {
          queueMicrotask(() => active?.interruptUnsafe())
        },
        credentialFileOps: {
          rename: (from, to) => {
            activationCalls += 1
            renameSync(from, to)
          },
          syncDirectory() {},
        },
      },
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(activationCalls).toBe(0)
    expect(await fs.readFile(roots.auth)).toEqual(before)
    expect((await fs.readdir(roots.data)).filter((file) => file !== "auth.json")).toEqual([])
  })

  test("post-commit release defects cannot turn the active replacement into failure", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    let releaseAttempts = 0

    const exit = await runAuth(
      tmp.path,
      Auth.Service.use((auth) => Effect.exit(auth.set("provider", api("committed")))),
      undefined,
      {
        acquireLock: async () => ({
          release() {
            releaseAttempts += 1
            throw new Error("synthetic post-commit release defect")
          },
        }),
      },
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(releaseAttempts).toBeGreaterThanOrEqual(3)
    expect(JSON.parse(await fs.readFile(roots.auth, "utf8"))).toEqual({
      provider: { type: "api", key: "committed" },
    })
  })

  test("a transient release failure is retried inside the commit tail", async () => {
    await using tmp = await tmpdir()
    let releaseAttempts = 0

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("committed"))),
      undefined,
      {
        acquireLock: async () => ({
          release() {
            releaseAttempts += 1
            if (releaseAttempts === 1) throw new Error("synthetic transient release defect")
          },
        }),
      },
    )

    expect(releaseAttempts).toBe(2)
  })

  test("lock acquisition failures are safe typed errors rooted in yielded channel state", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    await fs.mkdir(path.dirname(roots.state), { recursive: true })
    await fs.writeFile(roots.state, "state-root-is-not-a-directory")
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.set("provider", api("synthetic")))),
      ),
    )
    expect(failure.error).toMatchObject({ operation: "lock", reason: "unavailable" })
    expect(await Bun.file(roots.auth).exists()).toBe(false)
  })

  test("synchronous lock driver failures are converted to safe typed errors", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.set("provider", api("synthetic")))),
        undefined,
        {
          acquireLock: () => {
            throw new Error("synchronous-lock-secret:" + roots.auth)
          },
        },
      ),
    )
    expect(failure.error).toMatchObject({ operation: "lock", reason: "unavailable" })
    const rendered = [String(failure.error), JSON.stringify(failure.cause), Cause.pretty(failure.cause)].join("\n")
    expect(rendered).not.toContain("synchronous-lock-secret")
    expect(rendered).not.toContain(roots.auth)
  })

  test("native lock recognizes base and extended SQLite busy result codes", () => {
    expect(AuthLock.isBusy({ errno: 5 })).toBe(true)
    expect(AuthLock.isBusy({ errcode: 5 })).toBe(true)
    expect(AuthLock.isBusy({ errno: 5 | (1 << 8) })).toBe(true)
    expect(AuthLock.isBusy({ errcode: 5 | (3 << 8) })).toBe(true)
    expect(AuthLock.isBusy({ code: "SQLITE_BUSY_TIMEOUT" })).toBe(true)
    expect(AuthLock.isBusy({ code: "SQLITE_LOCKED" })).toBe(false)
  })

  test("an old native lease cannot release or disturb its successor", async () => {
    await using tmp = await tmpdir()
    const lockDirectory = path.join(tmp.path, "locks")
    const lockFile = path.join(lockDirectory, "auth-store.sqlite")
    await fs.mkdir(lockDirectory, { recursive: true })

    const first = await AuthLock.acquire(lockFile)
    await first.release()
    const successor = await AuthLock.acquire(lockFile)
    await first.release()

    let blocked = false
    try {
      await AuthLock.acquire(lockFile, { timeoutMs: 0 })
    } catch {
      blocked = true
    }
    expect(blocked).toBe(true)
    await successor.release()
    const after = await AuthLock.acquire(lockFile, { timeoutMs: 0 })
    await after.release()
  })

  test("native release retries rollback and close failures without unlocking or disturbing a successor", async () => {
    await using tmp = await tmpdir()
    const lockDirectory = path.join(tmp.path, "locks")
    const lockFile = path.join(lockDirectory, "auth-store.sqlite")
    await fs.mkdir(lockDirectory, { recursive: true })
    let rollbackAttempts = 0
    let closeAttempts = 0
    const lease = await AuthLock.acquire(lockFile, {
      open(file) {
        const database = openAuthLockDatabase(file)
        return {
          exec(sql) {
            if (sql === "ROLLBACK" && rollbackAttempts++ === 0) throw new Error("synthetic rollback failure")
            database.exec(sql)
          },
          close() {
            if (closeAttempts++ === 0) throw new Error("synthetic close failure")
            database.close()
          },
        }
      },
    })

    expect(() => lease.release()).toThrow("synthetic rollback failure")
    await expect(AuthLock.acquire(lockFile, { timeoutMs: 0 })).rejects.toThrow()
    expect(() => lease.release()).not.toThrow()
    const successor = await AuthLock.acquire(lockFile)
    expect(() => lease.release()).not.toThrow()
    await expect(AuthLock.acquire(lockFile, { timeoutMs: 0 })).rejects.toThrow()
    successor.release()
    expect({ rollbackAttempts, closeAttempts }).toEqual({ rollbackAttempts: 2, closeAttempts: 2 })
  })

  test("a live native holder is never evicted during a multi-second callback", async () => {
    await using tmp = await tmpdir()
    const lockDirectory = path.join(tmp.path, "locks")
    const lockFile = path.join(lockDirectory, "auth-store.sqlite")
    await fs.mkdir(lockDirectory, { recursive: true })
    const holder = await AuthLock.acquire(lockFile)
    let signalWait!: () => void
    const waited = new Promise<void>((resolve) => {
      signalWait = resolve
    })
    let entered = false
    const contender = AuthLock.acquire(lockFile, {
      onWait: () => signalWait(),
    }).then((lease) => {
      entered = true
      return lease
    })
    await waited
    await Bun.sleep(2_100)
    expect(entered).toBe(false)
    await holder.release()
    const lease = await contender
    await lease.release()
  }, 10_000)

  test("lock release failures remain safe typed errors and do not retain native causes", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) =>
          Effect.exit(
            auth.transaction("provider", () => Effect.succeed({ action: "keep" as const, result: undefined })),
          ),
        ),
        undefined,
        {
          acquireLock: async (file) => {
            expect(file).toBe(path.join(roots.state, "locks", "auth-store.sqlite"))
            return {
              release() {
                throw new Error("release-defect-seeded-secret:" + roots.auth)
              },
            }
          },
        },
      ),
    )
    expect(failure.error).toMatchObject({ operation: "lock", reason: "unavailable" })
    const rendered = [String(failure.error), JSON.stringify(failure.cause), Cause.pretty(failure.cause)].join("\n")
    expect(rendered).not.toContain("release-defect-seeded-secret")
    expect(rendered).not.toContain(roots.auth)
  })

  test("successful output strictly decodes as the complete auth-store schema", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.all([
          auth.set("api", api("synthetic")),
          auth.set("oauth", {
            type: "oauth",
            refresh: "refresh-synthetic",
            access: "access-synthetic",
            expires: 123,
          }),
        ]),
      ),
    )
    expect(
      Schema.decodeUnknownSync(Auth.Store)(JSON.parse(await fs.readFile(completeGlobal(tmp.path).auth, "utf8")), {
        onExcessProperty: "error",
      }),
    ).toEqual({
      api: api("synthetic"),
      oauth: new Auth.Oauth({
        type: "oauth",
        refresh: "refresh-synthetic",
        access: "access-synthetic",
        expires: 123,
      }),
    })
  })

  test("16 barrier-synchronized subprocess writers preserve every record", async () => {
    await using tmp = await tmpdir()
    const barrier = path.join(tmp.path, "workers")
    const gate = path.join(barrier, "go")
    await fs.mkdir(barrier, { recursive: true })
    const inputs = Array.from({ length: 16 }, (_, index) => ({
      mode: "set" as const,
      root: tmp.path,
      ready: path.join(barrier, `ready-${index}`),
      gate,
      key: `worker-${index}`,
      value: `value-${index}`,
    }))
    const workers = inputs.map(spawnWorker)
    await waitForFiles(inputs.map((input) => input.ready))
    await fs.writeFile(gate, "go")
    await expectWorkers(workers)
    const store = await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.all()),
    )
    expect(Object.keys(store).sort()).toEqual(inputs.map((input) => input.key).sort())
  }, 60_000)

  test("concurrent independent sets and removal neither lose records nor resurrect state", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("victim", api("remove-me"))),
    )
    const barrier = path.join(tmp.path, "mixed")
    const gate = path.join(barrier, "go")
    await fs.mkdir(barrier, { recursive: true })
    const setters = Array.from({ length: 12 }, (_, index) => ({
      mode: "set" as const,
      root: tmp.path,
      ready: path.join(barrier, `set-${index}`),
      gate,
      key: `survivor-${index}`,
      value: `value-${index}`,
    }))
    const removers = Array.from({ length: 4 }, (_, index) => ({
      mode: "remove" as const,
      root: tmp.path,
      ready: path.join(barrier, `remove-${index}`),
      gate,
      key: "victim",
    }))
    const inputs = [...setters, ...removers]
    const workers = inputs.map(spawnWorker)
    await waitForFiles(inputs.map((input) => input.ready))
    await fs.writeFile(gate, "go")
    await expectWorkers(workers)
    const store = await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.all()),
    )
    expect(store.victim).toBeUndefined()
    expect(setters.every((input) => store[input.key]?.type === "api")).toBe(true)
  }, 60_000)

  test("callback failure and interruption preserve bytes and release the lock", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("before"))),
    )
    const before = await fs.readFile(roots.auth)

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const failed = yield* Effect.exit(
            auth.transaction("provider", () => Effect.fail("synthetic callback failure")),
          )
          expect(Exit.isFailure(failed)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(roots.auth))).toEqual(before)

          const entered = yield* Deferred.make<void>()
          const fiber = yield* auth
            .transaction("provider", () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
          expect(yield* Effect.promise(() => fs.readFile(roots.auth))).toEqual(before)

          yield* auth.set("after", api("lock-released"))
          expect((yield* auth.all()).after).toEqual(api("lock-released"))
        }),
      ),
    )
  })

  test("callback defects and timeouts release the lock for the next transaction", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const defect = yield* Effect.exit(
            auth.transaction("provider", () => Effect.die("callback-defect-seeded-secret")),
          )
          expect(Exit.isFailure(defect)).toBe(true)
          yield* auth.set("after-defect", api("available"))

          const timeout = yield* Effect.exit(
            auth.transaction("provider", () =>
              Effect.never.pipe(Effect.timeout("10 millis"), Effect.as({ action: "keep" as const, result: undefined })),
            ),
          )
          expect(Exit.isFailure(timeout)).toBe(true)
          yield* auth.set("after-timeout", api("available"))
        }),
      ),
    )
  })

  test("a contender blocked on the native lock can be interrupted before the holder releases", async () => {
    await using tmp = await tmpdir()
    let publishWait!: () => void
    const waited = new Promise<void>((resolve) => {
      publishWait = resolve
    })

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const holderEntered = yield* Deferred.make<void>()
          const releaseHolder = yield* Deferred.make<void>()
          const holder = yield* auth
            .transaction("provider", () =>
              Deferred.succeed(holderEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHolder)),
                Effect.as({ action: "keep" as const, result: undefined }),
              ),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(holderEntered)

          const contender = yield* auth
            .transaction("provider", () => Effect.succeed({ action: "keep" as const, result: undefined }))
            .pipe(Effect.forkScoped)
          yield* Effect.promise(() => waited)
          yield* Fiber.interrupt(contender).pipe(Effect.timeout("1 second"))
          const interrupted = yield* Fiber.await(contender)
          expect(Exit.isFailure(interrupted)).toBe(true)
          if (Exit.isFailure(interrupted)) expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)

          yield* Deferred.succeed(releaseHolder, undefined)
          yield* Fiber.join(holder)
          yield* auth.set("after", api("lock-still-healthy"))
        }),
      ),
      undefined,
      {
        onLockWait: () => publishWait(),
      },
    )
  })

  test("same-turn interruption after a successful acquisition still releases the lease exactly once", async () => {
    await using tmp = await tmpdir()
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    let complete!: (lease: AuthLock.Lease) => void
    let releases = 0

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const fiber = yield* auth
            .transaction("provider", () => Effect.succeed({ action: "keep" as const, result: undefined }))
            .pipe(Effect.forkScoped)
          yield* Effect.promise(() => started)
          complete({
            release() {
              releases += 1
            },
          })
          queueMicrotask(() => fiber.interruptUnsafe())
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(releases).toBe(1)
        }),
      ),
      undefined,
      {
        acquireLock: () =>
          new Promise((resolve) => {
            complete = resolve
            signalStarted()
          }),
      },
    )
  })

  test("acquisition handoff cleanup retries a transient synchronous release failure", async () => {
    await using tmp = await tmpdir()
    let active: Fiber.Fiber<unknown, unknown> | undefined
    let releaseAttempts = 0

    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          const fiber = yield* auth.transaction("provider", () => Effect.never).pipe(Effect.forkScoped)
          active = fiber
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(releaseAttempts).toBe(2)
        }),
      ),
      undefined,
      {
        acquireLock: async () => {
          queueMicrotask(() => active?.interruptUnsafe())
          return {
            release() {
              releaseAttempts += 1
              if (releaseAttempts === 1) throw new Error("synthetic transient handoff release defect")
            },
          }
        },
      },
    )
  })

  test("queued interruption after the acquisition promise resolves releases every handoff lease", async () => {
    await using tmp = await tmpdir()
    let active: Fiber.Fiber<unknown, unknown> | undefined
    let releases = 0
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          for (let index = 0; index < 200; index++) {
            active = undefined
            const fiber = yield* auth
              .transaction("provider", () => Effect.never)
              .pipe(Effect.forkScoped({ startImmediately: true }))
            active = fiber
            const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
            expect(Exit.isFailure(exit)).toBe(true)
          }
          expect(releases).toBe(200)
        }),
      ),
      undefined,
      {
        acquireLock: async () => {
          queueMicrotask(() => active?.interruptUnsafe())
          return {
            release() {
              releases += 1
            },
          }
        },
      },
    )
  })

  test("queued-microtask interruption across the production bracket never leaks a native lease", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          for (let index = 0; index < 20; index++) {
            const fiber = yield* auth
              .transaction("provider", () => Effect.never)
              .pipe(Effect.forkScoped({ startImmediately: true }))
            queueMicrotask(() => fiber.interruptUnsafe())
            const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
            expect(Exit.isFailure(exit)).toBe(true)
            yield* auth.set(`probe-${index}`, api("available")).pipe(Effect.timeout("1 second"))
          }
        }),
      ),
    )
  })

  test("a blocked process re-reads the holder's rotated record under the same lock", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        auth.set("provider", {
          type: "oauth",
          refresh: "refresh-r1",
          access: "access-r1",
          expires: 1,
        }),
      ),
    )
    const barrier = path.join(tmp.path, "handoff")
    const holderReady = path.join(barrier, "holder-ready")
    const contenderReady = path.join(barrier, "contender-attempt")
    const release = path.join(barrier, "holder-release")
    const seen = path.join(barrier, "contender-seen")
    await fs.mkdir(barrier, { recursive: true })

    const holder = spawnWorker({ mode: "holder", root: tmp.path, ready: holderReady, gate: release, key: "provider" })
    await waitForFiles([holderReady])
    const contender = spawnWorker({
      mode: "contender",
      root: tmp.path,
      ready: contenderReady,
      seen,
      key: "provider",
    })
    await waitForFiles([contenderReady])
    await fs.writeFile(release, "commit")
    await expectWorkers([holder, contender])
    expect(await fs.readFile(seen, "utf8")).toBe("access-r2")
    const record = await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.get("provider")),
    )
    expect(record?.type).toBe("oauth")
    if (record?.type === "oauth") expect(record.access).toBe("access-r2")
  }, 60_000)

  test("a process killed while holding the native lock releases it immediately", async () => {
    await using tmp = await tmpdir()
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        auth.set("provider", {
          type: "oauth",
          refresh: "refresh-r1",
          access: "access-r1",
          expires: 1,
        }),
      ),
    )

    const barrier = path.join(tmp.path, "killed-owner")
    const holderReady = path.join(barrier, "holder-ready")
    const neverRelease = path.join(barrier, "never-release")
    await fs.mkdir(barrier, { recursive: true })
    const holder = spawnWorker({
      mode: "holder",
      root: tmp.path,
      ready: holderReady,
      gate: neverRelease,
      key: "provider",
    })
    await waitForFiles([holderReady])
    holder.kill("SIGKILL")
    await holder.exited

    const ready = path.join(barrier, "recovery-ready")
    const gate = path.join(barrier, "recovery-go")
    const recovery = spawnWorker({
      mode: "set",
      root: tmp.path,
      ready,
      gate,
      key: "recovered",
      value: "after-kill",
    })
    await waitForFiles([ready])
    await fs.writeFile(gate, "go")
    await expectWorkerWithin(recovery)

    expect(
      await runAuth(
        tmp.path,
        Auth.Service.use((auth) => auth.get("recovered")),
      ),
    ).toEqual(api("after-kill"))
  }, 15_000)

  test("legacy BharatCode and OpenCode credential sentinels are never read or changed", async () => {
    await using tmp = await tmpdir()
    const legacyBharatCode = path.join(tmp.path, ".bharatcode", "credentials.json")
    const legacyOpenCode = path.join(tmp.path, ".local", "share", "opencode", "auth.json")
    const sentinels = new Map([
      [legacyBharatCode, Buffer.from("legacy-bharatcode-sentinel")],
      [legacyOpenCode, Buffer.from("legacy-opencode-sentinel")],
    ])
    for (const [file, value] of sentinels) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, value)
    }
    const reads: string[] = []
    const filesystem = wrappedFilesystem((base) => ({
      ...base,
      readFile: (file) => {
        reads.push(file)
        if (sentinels.has(file)) return Effect.die("legacy credential read")
        return base.readFile(file)
      },
      readFileString: (file, encoding) => {
        reads.push(file)
        if (sentinels.has(file)) return Effect.die("legacy credential read")
        return base.readFileString(file, encoding)
      },
      readJson: (file) => {
        reads.push(file)
        if (sentinels.has(file)) return Effect.die("legacy credential read")
        return base.readJson(file)
      },
    }))
    await runAuth(
      tmp.path,
      Auth.Service.use((auth) => auth.set("provider", api("synthetic"))),
      filesystem,
    )
    expect(reads.some((file) => sentinels.has(file))).toBe(false)
    for (const [file, value] of sentinels) expect(await fs.readFile(file)).toEqual(value)
  })

  test("credential-store errors and causes never retain seeded secrets or paths", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const secrets = ["sk-seeded-api-secret", "access-seeded-secret", "refresh-seeded-secret"]
    await seedPrivateCredential(
      tmp.path,
      JSON.stringify({
        provider: {
          type: "oauth",
          access: secrets[1],
          refresh: secrets[2],
          expires: "invalid",
          apiKey: secrets[0],
        },
      }),
    )
    const failure = await expectAuthError(
      runAuth(
        tmp.path,
        Auth.Service.use((auth) => Effect.exit(auth.all())),
      ),
    )
    const rendered = [
      String(failure.error),
      JSON.stringify(failure.error),
      JSON.stringify(failure.cause),
      Cause.pretty(failure.cause),
    ].join("\n")
    for (const secret of secrets) expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain(roots.auth)
    expect(Object.hasOwn(failure.error, "cause")).toBe(false)
  })

  test("Auth-owned spans and logs never serialize callback or store secret content", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const callbackSecret = "callback-token-seeded-secret"
    const storeSecret = "store-token-seeded-secret"
    const telemetry = captureTelemetry()

    const callbackExit = await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.exit(auth.transaction("provider", () => Effect.fail(new Error(callbackSecret + ":" + roots.auth)))),
      ).pipe(Effect.withTracer(telemetry.tracer), Effect.provide(Logger.layer([telemetry.logger]))),
    )
    expect(Exit.isFailure(callbackExit)).toBe(true)

    await seedPrivateCredential(
      tmp.path,
      JSON.stringify({ provider: { type: "oauth", access: storeSecret, refresh: roots.auth, expires: "bad" } }),
    )
    const storeExit = await runAuth(
      tmp.path,
      Auth.Service.use((auth) => Effect.exit(auth.all())).pipe(
        Effect.withTracer(telemetry.tracer),
        Effect.provide(Logger.layer([telemetry.logger])),
      ),
    )
    expect(Exit.isFailure(storeExit)).toBe(true)

    const rendered = renderTelemetry(telemetry)
    expect(telemetry.spans.some((span) => span.name === "Auth.transaction")).toBe(false)
    expect(rendered).not.toContain(callbackSecret)
    expect(rendered).not.toContain(storeSecret)
    expect(rendered).not.toContain(roots.auth)
  })

  test("successful secret-bearing reads are absent from Auth-owned spans and logs", async () => {
    await using tmp = await tmpdir()
    const roots = completeGlobal(tmp.path)
    const secret = "successful-read-seeded-token"
    await seedPrivateCredential(tmp.path, JSON.stringify({ provider: { type: "api", key: secret } }))
    const telemetry = captureTelemetry()

    const result = await runAuth(
      tmp.path,
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          expect((yield* auth.get("provider"))?.type).toBe("api")
          expect(Object.keys(yield* auth.all())).toEqual(["provider"])
        }),
      ).pipe(Effect.withTracer(telemetry.tracer), Effect.provide(Logger.layer([telemetry.logger]))),
    )
    expect(result).toBeUndefined()
    const rendered = renderTelemetry(telemetry)
    expect(telemetry.spans.some((span) => span.name === "Auth.all" || span.name === "Auth.get")).toBe(false)
    expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain(roots.auth)
  })
})
