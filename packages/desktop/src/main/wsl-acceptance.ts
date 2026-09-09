import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, posix } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const WSL_ACCEPTANCE_FLAG = "--bharatcode-wsl-acceptance-case"

const argumentNames = new Map([
  [WSL_ACCEPTANCE_FLAG, "case"],
  ["--runtime-manifest", "runtimeManifest"],
  ["--distribution", "distribution"],
  ["--invalid-distribution", "invalidDistribution"],
  ["--missing-prerequisite-distribution", "missingPrerequisiteDistribution"],
  ["--windows-project", "windowsProject"],
  ["--source-sha", "sourceSha"],
  ["--acceptance-dir", "acceptanceDirectory"],
] as const)

export interface WslAcceptanceInput {
  readonly acceptanceDirectory: string
  readonly case: "scenario-9" | "scenario-10-before-restart" | "scenario-10-after-restart"
  readonly distribution: string
  readonly invalidDistribution: string
  readonly missingPrerequisiteDistribution: string
  readonly runtimeManifest: string
  readonly sourceSha: string
  readonly windowsProject: string
}

export type WslAcceptanceDispatch =
  | { readonly kind: "ordinary" }
  | { readonly kind: "acceptance"; readonly input: WslAcceptanceInput }

export function resolveWslAcceptanceInvocation(
  argv: readonly string[],
  environment: { readonly packaged: boolean; readonly platform: string },
): WslAcceptanceDispatch {
  if (!argv.includes(WSL_ACCEPTANCE_FLAG)) return { kind: "ordinary" }
  if (!environment.packaged || environment.platform !== "win32") {
    throw new Error("Packaged WSL acceptance is unavailable")
  }
  if (argv.length !== argumentNames.size * 2) throw new Error("Malformed packaged WSL acceptance invocation")

  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argumentNames.get(argv[index] as never)
    const value = argv[index + 1]
    if (!name || !value || values.has(name) || /[\0\r\n]/u.test(value)) {
      throw new Error("Malformed packaged WSL acceptance invocation")
    }
    values.set(name, value)
  }

  const caseName = values.get("case")
  const sourceSha = values.get("sourceSha")
  if (
    !["scenario-9", "scenario-10-before-restart", "scenario-10-after-restart"].includes(caseName ?? "") ||
    !sourceSha?.match(/^[0-9a-f]{40}$/u)
  ) {
    throw new Error("Malformed packaged WSL acceptance invocation")
  }

  return {
    kind: "acceptance",
    input: {
      acceptanceDirectory: values.get("acceptanceDirectory")!,
      case: caseName as WslAcceptanceInput["case"],
      distribution: values.get("distribution")!,
      invalidDistribution: values.get("invalidDistribution")!,
      missingPrerequisiteDistribution: values.get("missingPrerequisiteDistribution")!,
      runtimeManifest: values.get("runtimeManifest")!,
      sourceSha,
      windowsProject: values.get("windowsProject")!,
    },
  }
}

export function completeWslAcceptanceOutput(
  record: string,
  output: { write: (chunk: string, callback: (error?: Error | null) => void) => unknown },
  exit: (code: number) => void,
) {
  let completed = false
  const finish = (code: number) => {
    if (completed) return
    completed = true
    exit(code)
  }
  try {
    output.write(`${record}\n`, (error) => finish(error ? 1 : 0))
  } catch {
    finish(1)
  }
}

type SessionSnapshot = {
  enabled?: boolean
  selectedDisplayName?: string
  version?: number
  phase: "ready" | "running" | "error"
  code?: string
}

type RuntimeEffect = {
  origin: string
  password: string
  identity: { source_sha: string; version: string; executable_sha256: string; uid: number }
  selectedIdentity: { user: string; uid: number; home: string }
  authorization: {
    origin: string
    authorize: (target: string, headers: Headers) => Headers
  }
  generation: number
}

export interface WslAcceptanceSession {
  snapshot: () => Promise<SessionSnapshot>
  configure: (displayName: string) => Promise<SessionSnapshot>
  start: () => Promise<RuntimeEffect>
  stop: () => Promise<void>
  restart: () => Promise<RuntimeEffect>
  closeInputAndObserve: () => Promise<{ phase: "running"; runtime: RuntimeEffect } | { phase: "error"; code: string }>
  status: () => string
  currentGeneration: () => number | undefined
  translateProject: (path: string) => Promise<string>
  openProject: (path: string) => Promise<void>
  verifyCanonicalStorage: (runtime: RuntimeEffect) => Promise<boolean>
  health: (origin: string, credentials?: { username: string; password: string }) => Promise<boolean>
  startSentinel: () => Promise<{ alive: () => boolean; stop: () => Promise<void> }>
}

export interface WslAcceptanceDependencies {
  createSession: (input: WslAcceptanceInput) => Promise<WslAcceptanceSession>
  executablePath: string
  readFile: (path: string) => Promise<Uint8Array>
}

export async function waitForAcceptanceHealth(
  check: (url: string, username?: string | null, password?: string | null) => Promise<boolean>,
  url: string,
  username?: string | null,
  password?: string | null,
  delay: (milliseconds: number) => Promise<unknown> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  for (const milliseconds of password ? [0, 25, 50, 100, 250, 500, 1_000] : [0]) {
    if (milliseconds > 0) await delay(milliseconds)
    if (await check(url, username, password)) return true
  }
  return false
}

export async function runPackagedWslAcceptance(
  input: WslAcceptanceInput,
  dependencies?: WslAcceptanceDependencies,
): Promise<string> {
  const active = dependencies ?? (await createProductionDependencies(input))
  const session = await active.createSession(input)

  if (input.case === "scenario-10-after-restart") {
    requireReady(await session.snapshot(), input.distribution)
    const runtime = await session.start()
    try {
      await verifyRuntimeEffect(input, runtime, active)
    } finally {
      await session.stop()
    }
    requireStopped(session, "ready")
    return encodeObservation(input, runtime, active, {
      harness_processes_gone: true,
      ordinary_stop: true,
      persisted_selection: true,
    })
  }

  requireReady(await session.configure(input.distribution), input.distribution)
  if (input.case === "scenario-9") {
    const runtime = await session.start()
    try {
      await verifyRuntimeEffect(input, runtime, active)
      await verifyAuthorizationEffect(session, runtime)
      if (!(await session.verifyCanonicalStorage(runtime))) throw new Error("Canonical WSL storage was not verified")
      const translated = await session.translateProject(input.windowsProject)
      if (!translated.startsWith("/") || /[\0\r\n]/u.test(translated)) throw new Error("Project translation failed")
      await session.openProject(translated)
    } finally {
      await session.stop()
    }
    requireStopped(session, "ready")
    return encodeObservation(input, runtime, active, {
      authenticated_loopback: true,
      inside_selected_distro: true,
      non_root: true,
      packaged_desktop: true,
      packaged_runtime: true,
      project_round_trip: true,
      source_identity: true,
      storage_inside_distro: true,
      unauthenticated_rejected: true,
    })
  }

  const invalid = await session.configure(input.invalidDistribution)
  if (invalid.phase !== "error" || invalid.code !== "root-user") throw new Error("Root distribution was not rejected")
  requireReady(await session.configure(input.distribution), input.distribution)
  const sentinel = await session.startSentinel()
  let runtime: RuntimeEffect | undefined
  try {
    runtime = await session.start()
    await verifyRuntimeEffect(input, runtime, active)
    await verifyAuthorizationEffect(session, runtime)
    await session.stop()
    requireStopped(session, "ready")
    const beforeRestart = await session.start()
    runtime = await session.restart()
    if (runtime.generation <= beforeRestart.generation) throw new Error("Restart did not replace the owned runtime")
    await session.stop()
    requireStopped(session, "ready")
    if (!sentinel.alive()) throw new Error("Unrelated sentinel exited during owned lifecycle effects")

    requireReady(await session.configure(input.missingPrerequisiteDistribution), input.missingPrerequisiteDistribution)
    let missingCode: string | undefined
    try {
      await session.start()
    } catch (error) {
      missingCode = errorCode(error)
    }
    if (missingCode !== "prerequisite-missing") throw new Error("Missing prerequisite was not rejected")
    requireReady(await session.configure(input.distribution), input.distribution)
    runtime = await session.start()
    const beforeReconnect = runtime.generation
    const firstLoss = await session.closeInputAndObserve()
    if (firstLoss.phase !== "running" || firstLoss.runtime.generation <= beforeReconnect) {
      throw new Error("First child EOF did not reconnect to a replacement")
    }
    runtime = firstLoss.runtime
    const secondLoss = await session.closeInputAndObserve()
    if (secondLoss.phase !== "error" || secondLoss.code !== "connection-lost") {
      throw new Error("Repeated child EOF was not visible")
    }
    requireStopped(session, "connection-lost")
    if (!sentinel.alive()) throw new Error("Unrelated sentinel exited during recovery")
  } finally {
    await sentinel.stop()
  }
  if (!runtime) throw new Error("Scenario 10 did not execute a runtime")
  return encodeObservation(input, runtime, active, {
    credentials_main_only: true,
    harness_processes_gone: true,
    invalid_distribution_recovery: true,
    missing_prerequisite_recovery: true,
    one_reconnect: true,
    ordinary_stop: true,
    repeated_crash_visible: true,
    restart: true,
    unrelated_process_preserved: true,
  })
}

function requireReady(snapshot: SessionSnapshot, displayName: string) {
  if (
    snapshot.enabled !== true ||
    snapshot.selectedDisplayName !== displayName ||
    snapshot.version !== 2 ||
    snapshot.phase !== "ready"
  ) {
    throw new Error("Selected WSL2 distribution is not ready")
  }
}

function requireStopped(session: WslAcceptanceSession, status: "ready" | "connection-lost") {
  if (session.currentGeneration() !== undefined || session.status() !== status) {
    throw new Error("Owned WSL runtime was not fully closed")
  }
}

async function verifyAuthorizationEffect(session: WslAcceptanceSession, runtime: RuntimeEffect) {
  if (runtime.authorization.origin !== runtime.origin) throw new Error("Runtime authorization origin mismatch")
  const authorized = runtime.authorization.authorize(runtime.origin, new Headers())
  if (!authorized.get("authorization")?.startsWith("Basic ")) throw new Error("Runtime authorization was not applied")
  const foreign = runtime.authorization.authorize("http://127.0.0.1:1", authorized)
  if (foreign.has("authorization")) throw new Error("Runtime authorization escaped its exact origin")
  if (await session.health(runtime.origin)) throw new Error("Unauthenticated runtime health was accepted")
  if (!(await session.health(runtime.origin, { username: "bharatcode", password: runtime.password }))) {
    throw new Error("Authenticated runtime health was rejected")
  }
  if (
    process.argv.some((value) => value.includes(runtime.password)) ||
    Object.values(process.env).some((value) => value?.includes(runtime.password))
  ) {
    throw new Error("Runtime credential escaped main memory")
  }
}

async function verifyRuntimeEffect(
  input: WslAcceptanceInput,
  runtime: RuntimeEffect,
  dependencies: WslAcceptanceDependencies,
) {
  const manifest = parseCanonicalManifest(Buffer.from(await dependencies.readFile(input.runtimeManifest)))
  if (
    manifest.source_sha !== input.sourceSha ||
    manifest.sha256 !== runtime.identity.executable_sha256 ||
    manifest.version !== runtime.identity.version ||
    runtime.identity.source_sha !== input.sourceSha ||
    runtime.identity.uid !== runtime.selectedIdentity.uid ||
    runtime.selectedIdentity.uid <= 0
  ) {
    throw new Error("Runtime identity did not match packaged and selected identity")
  }
}

function parseCanonicalManifest(bytes: Buffer) {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Packaged runtime manifest is invalid")
  }
  const keys = ["schema", "source_sha", "version", "arch", "filename", "bytes", "sha256"]
  if (!exactRecord(value, keys) || bytes.toString("utf8") !== `${JSON.stringify(value)}\n`) {
    throw new Error("Packaged runtime manifest is not closed canonical JSON")
  }
  if (
    value.schema !== 1 ||
    typeof value.source_sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.source_sha) ||
    typeof value.version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version) ||
    (value.arch !== "x64" && value.arch !== "arm64") ||
    typeof value.filename !== "string" ||
    value.filename !== `bharatcode-runtime-linux-${value.arch}-glibc` ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    throw new Error("Packaged runtime manifest identity is invalid")
  }
  return value as {
    schema: 1
    source_sha: string
    version: string
    arch: "x64" | "arm64"
    filename: string
    bytes: number
    sha256: string
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

async function encodeObservation(
  input: WslAcceptanceInput,
  runtime: RuntimeEffect,
  dependencies: WslAcceptanceDependencies,
  checks: Record<string, true>,
) {
  const manifestBytes = Buffer.from(await dependencies.readFile(input.runtimeManifest))
  const executableBytes = Buffer.from(await dependencies.readFile(dependencies.executablePath))
  const value = {
    schema: "bharatcode-wsl-packaged-case-v1",
    case: input.case,
    source_sha: input.sourceSha,
    desktop_sha256: createHash("sha256").update(executableBytes).digest("hex"),
    runtime_manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifest_source_sha: input.sourceSha,
    executed_source_sha: runtime.identity.source_sha,
    manifest_runtime_sha256: runtime.identity.executable_sha256,
    executed_runtime_sha256: runtime.identity.executable_sha256,
    distro_sha256: createHash("sha256").update(input.distribution).digest("hex"),
    user_sha256: createHash("sha256").update(runtime.selectedIdentity.user).digest("hex"),
    uid: runtime.selectedIdentity.uid,
    wsl_version: 2,
    checks,
  }
  const record = JSON.stringify(value)
  if (Buffer.byteLength(record) > 8_192 || /[\r\n]/u.test(record)) throw new Error("Acceptance record is not bounded")
  return record
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function createProductionDependencies(input: WslAcceptanceInput): Promise<WslAcceptanceDependencies> {
  const [{ app }, { CHANNEL }, { getStore }, distro, server, lifecycle, storagePaths] = await Promise.all([
    import("electron"),
    import("./constants"),
    import("./store"),
    import("./wsl-distro"),
    import("./server"),
    import("./wsl-lifecycle"),
    import("../../../core/src/storage-paths"),
  ])
  if (process.platform !== "win32" || !app.isPackaged) throw new Error("Packaged WSL acceptance requires Windows")
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Error("Packaged WSL acceptance architecture is unavailable")
  app.setPath("userData", join(input.acceptanceDirectory, "desktop-state"))
  const store = getStore("wsl-acceptance-selection")
  const service = distro.createWslService({
    platform: process.platform,
    env: process.env,
    readState: () => store.get("selection"),
    writeState: (value) => store.set("selection", value),
  })

  const createSession = async (): Promise<WslAcceptanceSession> => {
    let selectedDisplayName = input.distribution
    let generation = 0
    let current:
      | {
          generation: number
          spawned: Awaited<ReturnType<typeof server.spawnWslServer>>
          effect: RuntimeEffect
        }
      | undefined
    const port = await freeLoopbackPort()
    const password = randomUUID()
    const owned = lifecycle.createWslLifecycle({
      revalidate: async () => {
        requireReady(snapshot(await service.snapshot()), selectedDisplayName)
      },
      startOwned: async () => {
        try {
          const spawned = await server.spawnWslServer("127.0.0.1", port, password, {
            selectedDisplayName,
            resourcesPath: process.resourcesPath,
            version: app.getVersion(),
            arch: process.arch as "x64" | "arm64",
            channel: CHANNEL,
            hostEnv: process.env,
            healthCheck: (url, username, password) =>
              waitForAcceptanceHealth(server.checkHealth, url, username, password),
          })
          const nextGeneration = ++generation
          const effect: RuntimeEffect = {
            origin: spawned.authorization.origin,
            password,
            identity: spawned.identity,
            selectedIdentity: spawned.selectedIdentity,
            authorization: spawned.authorization,
            generation: nextGeneration,
          }
          const retained = { generation: nextGeneration, spawned, effect }
          current = retained
          void spawned.owned.exited.finally(() => {
            if (current === retained) current = undefined
          })
          return spawned.owned
        } catch (error) {
          throw lifecycle.classifyWslLaunchFailure(error)
        }
      },
    })

    const currentEffect = () => {
      if (!current) throw new Error("Owned WSL runtime is unavailable")
      return current.effect
    }
    const configure = async (displayName: string) => {
      const before = await service.snapshot()
      const result = await service.configure({
        enabled: true,
        expectedRevision: before.revision,
        selectedDisplayName: displayName,
      })
      if (result.status.phase === "ready") selectedDisplayName = displayName
      return snapshot(result)
    }

    return {
      snapshot: async () => snapshot(await service.snapshot()),
      configure,
      async start() {
        await owned.start()
        return currentEffect()
      },
      async stop() {
        await owned.stop()
        current = undefined
      },
      async restart() {
        await owned.restart()
        return currentEffect()
      },
      async closeInputAndObserve() {
        const before = currentEffect().generation
        current!.spawned.owned.closeInput()
        await waitFor(() => {
          const status = owned.status()
          return (
            (status.phase === "running" && Boolean(current && current.generation > before)) || status.phase === "error"
          )
        })
        const status = owned.status()
        if (status.phase === "running" && current && current.generation > before) {
          return { phase: "running", runtime: current.effect }
        }
        if (status.phase === "error") return { phase: "error", code: status.code }
        throw new Error("Unexpected WSL lifecycle observation")
      },
      status() {
        const status = owned.status()
        return status.phase === "error" ? status.code : status.phase
      },
      currentGeneration: () => current?.generation,
      translateProject: (path) => server.translateWslProjectPath(path, { selectedDisplayName, hostEnv: process.env }),
      async openProject(path) {
        await executeInside(selectedDisplayName, ["/usr/bin/test", "-d", path])
      },
      async verifyCanonicalStorage(runtime) {
        const paths = storagePaths.resolve({
          channel: CHANNEL,
          platform: "linux",
          home: runtime.selectedIdentity.home,
          temp: "/tmp",
          env: {},
        })
        if (
          runtime.selectedIdentity.uid <= 0 ||
          [paths.data, paths.config, paths.state, paths.storage, paths.database].some(
            (path) => !insideHome(runtime.selectedIdentity.home, path),
          )
        ) {
          return false
        }
        for (const [path, kind] of [
          [paths.data, "directory"],
          [paths.config, "directory"],
          [paths.state, "directory"],
          [paths.storage, "directory"],
          [paths.database, "regular file"],
        ] as const) {
          const resolved = closedLine(
            await executeInside(selectedDisplayName, ["/usr/bin/realpath", "--canonicalize-existing", "--", path]),
          )
          if (resolved !== path) return false
          const observed = closedLine(
            await executeInside(selectedDisplayName, ["/usr/bin/stat", "--format=%u:%F", "--", path]),
          )
          if (observed !== `${runtime.selectedIdentity.uid}:${kind}`) return false
        }
        return true
      },
      health: (origin, credentials) =>
        server.checkHealth(origin, credentials?.username ?? null, credentials?.password ?? null),
      startSentinel: () => startProductionSentinel(selectedDisplayName),
    }
  }

  const executeInside = async (displayName: string, args: readonly string[]) => {
    const executable = distro.trustedWindowsExecutables(process.env).wsl
    const result = await execFileAsync(executable, ["--distribution", displayName, "--exec", ...args], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    })
    return result.stdout
  }

  const startProductionSentinel = async (displayName: string) => {
    const executable = distro.trustedWindowsExecutables(process.env).wsl
    const child = spawn(executable, ["--distribution", displayName, "--exec", "/usr/bin/cat"], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    return {
      alive: () => child.exitCode === null && !child.killed,
      async stop() {
        child.stdin.end()
        await exited
      },
    }
  }

  return { createSession, executablePath: process.execPath, readFile }
}

function snapshot(value: {
  enabled: boolean
  selectedDisplayName?: string
  distributions: Array<{ displayName: string; version: 2 }>
  status: { phase: string; code?: string }
}): SessionSnapshot {
  const selected = value.distributions.find((item) => item.displayName === value.selectedDisplayName)
  return {
    enabled: value.enabled,
    selectedDisplayName: value.selectedDisplayName,
    version: selected?.version,
    phase: value.status.phase === "error" ? "error" : "ready",
    ...(value.status.code ? { code: value.status.code } : {}),
  }
}

function insideHome(home: string, path: string) {
  const relative = posix.relative(home, path)
  return relative.length > 0 && !relative.startsWith("../") && !posix.isAbsolute(relative)
}

function closedLine(value: string) {
  const result = value.replace(/\r?\n$/u, "")
  if (!result || /[\0\r\n]/u.test(result)) throw new Error("WSL acceptance command output is malformed")
  return result
}

function freeLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Loopback allocation failed"))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WSL acceptance observation timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
