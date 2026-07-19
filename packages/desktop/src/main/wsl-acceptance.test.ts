import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveWslAcceptanceInvocation, runPackagedWslAcceptance } from "./wsl-acceptance"

const validArguments = [
  "--bharatcode-wsl-acceptance-case",
  "scenario-9",
  "--runtime-manifest",
  "C:\\runtime\\manifest.json",
  "--distribution",
  "BharatCode",
  "--invalid-distribution",
  "InvalidRoot",
  "--missing-prerequisite-distribution",
  "MissingRuntime",
  "--windows-project",
  "C:\\project",
  "--source-sha",
  "93643f9df61651c5922400f04514b991bb4d2098",
  "--acceptance-dir",
  "C:\\acceptance",
] as const

const sourceSha = "93643f9df61651c5922400f04514b991bb4d2098"
const runtimeSha = "a".repeat(64)
const manifest = Buffer.from(
  `${JSON.stringify({
    schema: 1,
    source_sha: sourceSha,
    version: "1.2.3",
    arch: "x64",
    filename: "bharatcode-runtime-linux-x64-glibc",
    bytes: 1,
    sha256: runtimeSha,
  })}\n`,
)

function behavioralFixture() {
  let selected = "BharatCode"
  let phase: "ready" | "running" | "connection-lost" = "ready"
  let generation = 0
  let ownedGeneration: number | undefined
  let sentinelAlive = true
  const calls: string[] = []
  const runtime = () => ({
    origin: "http://127.0.0.1:4321",
    password: "private-password",
    identity: { source_sha: sourceSha, version: "1.2.3", executable_sha256: runtimeSha, uid: 1000 },
    selectedIdentity: { user: "private-user", uid: 1000, home: "/home/private-user" },
    authorization: {
      origin: "http://127.0.0.1:4321",
      authorize(target: string, headers: Headers) {
        const next = new Headers(headers)
        next.delete("authorization")
        if (target === "http://127.0.0.1:4321") next.set("authorization", "Basic closed")
        return next
      },
    },
    generation,
  })
  const session = {
    async snapshot() {
      calls.push("snapshot")
      return { enabled: true, selectedDisplayName: selected, version: 2, phase: "ready" as const }
    },
    async configure(displayName: string) {
      calls.push(`configure:${displayName}`)
      if (displayName === "InvalidRoot")
        return { selectedDisplayName: selected, version: 2, phase: "error" as const, code: "root-user" as const }
      selected = displayName
      return { enabled: true, selectedDisplayName: selected, version: 2, phase: "ready" as const }
    },
    async start() {
      calls.push(`start:${selected}`)
      if (selected === "MissingRuntime") throw Object.assign(new Error("missing"), { code: "prerequisite-missing" })
      phase = "running"
      generation += 1
      ownedGeneration = generation
      return runtime()
    },
    async stop() {
      calls.push("stop")
      phase = "ready"
      ownedGeneration = undefined
    },
    async restart() {
      calls.push("restart")
      generation += 1
      ownedGeneration = generation
      phase = "running"
      return runtime()
    },
    async closeInputAndObserve() {
      calls.push("eof")
      if (calls.filter((item) => item === "eof").length === 1) {
        generation += 1
        ownedGeneration = generation
        phase = "running"
        return { phase: "running" as const, runtime: runtime() }
      }
      phase = "connection-lost"
      ownedGeneration = undefined
      return { phase: "error" as const, code: "connection-lost" as const }
    },
    status: () => phase,
    currentGeneration: () => ownedGeneration,
    async translateProject() {
      calls.push("translate")
      return "/mnt/c/project"
    },
    async openProject(path: string) {
      calls.push(`open:${path}`)
    },
    async verifyCanonicalStorage() {
      calls.push("storage:canonical")
      return true
    },
    async health(_origin: string, credentials?: { username: string; password: string }) {
      calls.push(credentials ? "health:auth" : "health:unauth")
      return credentials?.password === "private-password"
    },
    async startSentinel() {
      calls.push("sentinel:start")
      sentinelAlive = true
      return {
        alive: () => sentinelAlive,
        async stop() {
          calls.push("sentinel:stop")
          sentinelAlive = false
        },
      }
    },
  }
  return {
    calls,
    session,
    dependencies: {
      createSession: async () => session,
      executablePath: "C:\\Program Files\\BharatCode.exe",
      readFile: async (path: string) => (path.endsWith("manifest.json") ? manifest : Buffer.from("desktop")),
    },
  }
}

describe("packaged WSL acceptance entrypoint", () => {
  test("leaves the ordinary Desktop path unchanged when the acceptance flag is absent", () => {
    expect(
      resolveWslAcceptanceInvocation(["bharatcode.exe", "--ordinary"], {
        packaged: true,
        platform: "win32",
      }),
    ).toEqual({ kind: "ordinary" })
  })

  test("accepts only the closed packaged Windows invocation", () => {
    expect(
      resolveWslAcceptanceInvocation(validArguments, {
        packaged: true,
        platform: "win32",
      }),
    ).toEqual({
      kind: "acceptance",
      input: {
        acceptanceDirectory: "C:\\acceptance",
        case: "scenario-9",
        distribution: "BharatCode",
        invalidDistribution: "InvalidRoot",
        missingPrerequisiteDistribution: "MissingRuntime",
        runtimeManifest: "C:\\runtime\\manifest.json",
        sourceSha: "93643f9df61651c5922400f04514b991bb4d2098",
        windowsProject: "C:\\project",
      },
    })
  })

  test("fails closed for malformed, unpackaged, and non-Windows acceptance invocations", () => {
    for (const [arguments_, environment] of [
      [["--bharatcode-wsl-acceptance-case", "scenario-9"], { packaged: true, platform: "win32" }],
      [validArguments, { packaged: false, platform: "win32" }],
      [validArguments, { packaged: true, platform: "linux" }],
    ] as const) {
      expect(() => resolveWslAcceptanceInvocation(arguments_, environment)).toThrow()
    }
  })

  test("dispatches the exact flag from the shipped entrypoint before ordinary main", () => {
    const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    const adapterSource = readFileSync(new URL("./wsl-acceptance.ts", import.meta.url), "utf8")
    const dispatch = indexSource.lastIndexOf("resolveWslAcceptanceInvocation")
    const acceptance = indexSource.indexOf('dispatch.kind === "acceptance"')
    const ordinaryMain = indexSource.indexOf("Effect.runFork(main)")

    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(acceptance).toBeGreaterThan(dispatch)
    expect(ordinaryMain).toBeGreaterThan(acceptance)
    expect(adapterSource).toContain('"--bharatcode-wsl-acceptance-case"')
  })

  test("never starts ordinary main after a rejected acceptance invocation", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    expect(source).toContain('dispatch = { kind: "rejected" }')
    expect(source).toContain('else if (dispatch.kind === "ordinary")')
  })

  test("fails closed off Windows without producing acceptance output", async () => {
    const root = mkdtempSync(join(tmpdir(), "bharatcode-wsl-cp5a-"))
    try {
      const dispatch = resolveWslAcceptanceInvocation(
        validArguments.map((value) => (value === "C:\\acceptance" ? root : value)),
        { packaged: true, platform: "win32" },
      )
      if (dispatch.kind !== "acceptance") throw new Error("expected acceptance dispatch")
      await expect(runPackagedWslAcceptance(dispatch.input)).rejects.toThrow()
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("derives scenario 9 only from production-shaped identity, authorization, health, and path effects", async () => {
    const fixture = behavioralFixture()
    const dispatch = resolveWslAcceptanceInvocation(validArguments, { packaged: true, platform: "win32" })
    if (dispatch.kind !== "acceptance") throw new Error("expected acceptance dispatch")
    const encoded = await runPackagedWslAcceptance(dispatch.input, fixture.dependencies)
    const record = JSON.parse(encoded)
    expect(record).toEqual({
      schema: "bharatcode-wsl-packaged-case-v1",
      case: "scenario-9",
      source_sha: sourceSha,
      desktop_sha256: createHash("sha256").update("desktop").digest("hex"),
      runtime_manifest_sha256: createHash("sha256").update(manifest).digest("hex"),
      manifest_source_sha: sourceSha,
      executed_source_sha: sourceSha,
      manifest_runtime_sha256: runtimeSha,
      executed_runtime_sha256: runtimeSha,
      distro_sha256: createHash("sha256").update("BharatCode").digest("hex"),
      user_sha256: createHash("sha256").update("private-user").digest("hex"),
      uid: 1000,
      wsl_version: 2,
      checks: {
        authenticated_loopback: true,
        inside_selected_distro: true,
        non_root: true,
        packaged_desktop: true,
        packaged_runtime: true,
        project_round_trip: true,
        source_identity: true,
        storage_inside_distro: true,
        unauthenticated_rejected: true,
      },
    })
    expect(fixture.calls).toContain("health:unauth")
    expect(fixture.calls).toContain("health:auth")
    expect(fixture.calls).toContain("open:/mnt/c/project")
    expect(fixture.calls).toContain("storage:canonical")
    expect(fixture.calls.at(-1)).toBe("stop")
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8_192)
    expect(encoded).not.toMatch(/[\r\n]/u)
    for (const forbidden of [
      "BharatCode",
      "private-user",
      "/home/private-user",
      "C:\\project",
      "/mnt/c/project",
      "private-password",
      "127.0.0.1",
      "4321",
    ]) {
      expect(encoded).not.toContain(forbidden)
    }
  })

  test("rejects instead of asserting checks when an underlying effect is false", async () => {
    for (const breakEffect of ["unauthenticated", "authorization", "path", "storage"] as const) {
      const fixture = behavioralFixture()
      if (breakEffect === "unauthenticated") fixture.session.health = async () => true
      if (breakEffect === "authorization") {
        const original = fixture.session.start
        fixture.session.start = async () => ({
          ...(await original()),
          authorization: { origin: "http://127.0.0.1:4321", authorize: (_target: string, headers: Headers) => headers },
        })
      }
      if (breakEffect === "path") fixture.session.translateProject = async () => "C:\\project"
      if (breakEffect === "storage") fixture.session.verifyCanonicalStorage = async () => false
      const dispatch = resolveWslAcceptanceInvocation(validArguments, { packaged: true, platform: "win32" })
      if (dispatch.kind !== "acceptance") throw new Error("expected acceptance dispatch")
      await expect(runPackagedWslAcceptance(dispatch.input, fixture.dependencies)).rejects.toThrow()
    }
  })

  test("binds canonical manifest version and strictly newer restart/reconnect generations", async () => {
    for (const breakEffect of [
      "version",
      "restart-generation",
      "reconnect-generation",
      "owned-after-stop",
      "status-after-stop",
    ] as const) {
      const fixture = behavioralFixture()
      if (breakEffect === "version") {
        const original = fixture.session.start
        fixture.session.start = async () => {
          const value = await original()
          return { ...value, identity: { ...value.identity, version: "9.9.9" } }
        }
      }
      if (breakEffect === "restart-generation") {
        const original = fixture.session.restart
        fixture.session.restart = async () => ({ ...(await original()), generation: 1 })
      }
      if (breakEffect === "reconnect-generation") {
        const original = fixture.session.closeInputAndObserve
        fixture.session.closeInputAndObserve = async () => {
          const result = await original()
          return result.phase === "running" ? { ...result, runtime: { ...result.runtime, generation: 1 } } : result
        }
      }
      if (breakEffect === "owned-after-stop") fixture.session.currentGeneration = () => 99
      if (breakEffect === "status-after-stop") fixture.session.status = () => "running"
      const arguments_ = validArguments.map((value) => (value === "scenario-9" ? "scenario-10-before-restart" : value))
      const dispatch = resolveWslAcceptanceInvocation(arguments_, { packaged: true, platform: "win32" })
      if (dispatch.kind !== "acceptance") throw new Error("expected acceptance dispatch")
      await expect(runPackagedWslAcceptance(dispatch.input, fixture.dependencies)).rejects.toThrow()
    }
  })

  test("runs scenario 10 as before/after process phases with persistence and lifecycle closure", async () => {
    for (const phaseName of ["scenario-10-before-restart", "scenario-10-after-restart"] as const) {
      const fixture = behavioralFixture()
      const arguments_ = validArguments.map((value) => (value === "scenario-9" ? phaseName : value))
      const dispatch = resolveWslAcceptanceInvocation(arguments_, { packaged: true, platform: "win32" })
      if (dispatch.kind !== "acceptance") throw new Error("expected acceptance dispatch")
      const record = JSON.parse(await runPackagedWslAcceptance(dispatch.input, fixture.dependencies))
      expect(record.case).toBe(phaseName)
      expect(Object.values(record.checks).every((value) => value === true)).toBeTrue()
      expect(fixture.calls.at(-1)).toMatch(/stop/u)
    }
  })

  test("default adapter is wired to production effects and consumes the spawned authorization", () => {
    const adapter = readFileSync(new URL("./wsl-acceptance.ts", import.meta.url), "utf8")
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8")
    expect(adapter).not.toContain("adapter is unavailable")
    expect(adapter).toContain("spawnWslServer")
    expect(adapter).toContain("createWslLifecycle")
    expect(adapter).toContain("translateWslProjectPath")
    expect(adapter).toContain("spawned.authorization")
    expect(adapter).not.toContain("createSidecarAuthorizationPolicy")
    expect(server).toContain("selectedIdentity: selected")
  })
})
