import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  acceptanceChildEnvironment,
  parseAcceptanceArguments,
  parseAcceptanceObservation,
  runWindowsAcceptance,
} from "./wsl-windows-acceptance.mjs"

const roots: string[] = []
const sourceSha = "9".repeat(40)
const runtime = Buffer.from("packaged-linux-runtime")
const runtimeSha256 = createHash("sha256").update(runtime).digest("hex")
const completedAt = "2026-07-20T00:00:00.000Z"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bharatcode-wsl-windows-acceptance-"))
  roots.push(root)
  const packageDirectory = join(root, "win-unpacked")
  const runtimeDirectory = join(packageDirectory, "resources", "wsl-runtime")
  const project = join(root, "project")
  const acceptanceDirectory = join(root, "acceptance")
  await Promise.all([mkdir(runtimeDirectory, { recursive: true }), mkdir(project), mkdir(acceptanceDirectory)])
  const desktopExe = join(packageDirectory, "BharatCode.exe")
  const runtimePath = join(runtimeDirectory, "bharatcode-runtime-linux-x64-glibc")
  const runtimeManifest = join(runtimeDirectory, "manifest.json")
  await writeFile(desktopExe, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(126), Buffer.from("PE\0\0candidate")]))
  await writeFile(runtimePath, runtime)
  await writeFile(
    runtimeManifest,
    `${JSON.stringify({
      schema: 1,
      source_sha: sourceSha,
      version: "1.15.21",
      arch: "x64",
      filename: "bharatcode-runtime-linux-x64-glibc",
      bytes: runtime.byteLength,
      sha256: runtimeSha256,
    })}\n`,
  )
  await Promise.all([chmod(desktopExe, 0o444), chmod(runtimePath, 0o444), chmod(runtimeManifest, 0o444)])
  const argv = [
    "--desktop-exe",
    desktopExe,
    "--runtime-manifest",
    runtimeManifest,
    "--distribution",
    "Ubuntu 24.04",
    "--invalid-distribution",
    "Invalid Root",
    "--missing-prerequisite-distribution",
    "Missing Tool",
    "--windows-project",
    "C:\\bharatcode-wsl-acceptance\\project",
    "--source-sha",
    sourceSha,
    "--acceptance-dir",
    acceptanceDirectory,
  ]
  const desktopSha256 = createHash("sha256")
    .update(await readFile(desktopExe))
    .digest("hex")
  const manifestSha256 = createHash("sha256")
    .update(await readFile(runtimeManifest))
    .digest("hex")
  const distroSha256 = createHash("sha256").update("Ubuntu 24.04").digest("hex")
  const common = {
    schema: "bharatcode-wsl-packaged-case-v1",
    source_sha: sourceSha,
    desktop_sha256: desktopSha256,
    runtime_manifest_sha256: manifestSha256,
    manifest_source_sha: sourceSha,
    executed_source_sha: sourceSha,
    manifest_runtime_sha256: runtimeSha256,
    executed_runtime_sha256: runtimeSha256,
    distro_sha256: distroSha256,
    user_sha256: createHash("sha256").update("alice").digest("hex"),
    uid: 1000,
    wsl_version: 2,
  }
  const observations = {
    "scenario-9": {
      ...common,
      case: "scenario-9",
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
    },
    "scenario-10": {
      ...common,
      case: "scenario-10",
      checks: {
        credentials_main_only: true,
        desktop_restart: true,
        harness_processes_gone: true,
        invalid_distribution_recovery: true,
        missing_prerequisite_recovery: true,
        one_reconnect: true,
        ordinary_stop: true,
        repeated_crash_visible: true,
        restart: true,
        unrelated_process_preserved: true,
      },
    },
  } as const
  return { root, argv, desktopExe, runtimePath, runtimeManifest, acceptanceDirectory, observations }
}

function dependencies(input: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    platform: "win32",
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "Windows",
      GITHUB_RUN_ID: "123456789",
      GITHUB_RUN_ATTEMPT: "2",
    },
    now: () => new Date(completedAt),
    inspectWsl: async () => [
      { displayName: "Ubuntu 24.04", version: 2 },
      { displayName: "Invalid Root", version: 2 },
      { displayName: "Missing Tool", version: 2 },
    ],
    verifyWindowsProject: async () => true,
    runCase: async ({ case: name }: { case: keyof typeof input.observations }) => input.observations[name],
    ...overrides,
  }
}

describe("packaged Windows/WSL2 acceptance contract", () => {
  test("passes only the closed Windows process environment to the executable case runner", () => {
    expect(
      acceptanceChildEnvironment({
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\runner",
        APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
        GITHUB_TOKEN: "ghp_private",
        BHARATCODE_SERVER_PASSWORD: "private-password",
        OPENCODE_SERVER_PASSWORD: "legacy-private-password",
      }),
    ).toEqual({
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\runner",
      APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
    })
  })

  test("parses only the exact single-use closed argument set", async () => {
    const input = await fixture()
    expect(parseAcceptanceArguments(input.argv)).toEqual({
      desktopExe: input.desktopExe,
      runtimeManifest: input.runtimeManifest,
      distribution: "Ubuntu 24.04",
      invalidDistribution: "Invalid Root",
      missingPrerequisiteDistribution: "Missing Tool",
      windowsProject: "C:\\bharatcode-wsl-acceptance\\project",
      sourceSha,
      acceptanceDirectory: input.acceptanceDirectory,
    })
    for (const argv of [
      [...input.argv, "--unknown", "value"],
      [...input.argv, "--distribution", "Debian"],
      input.argv.slice(0, -1),
      [...input.argv, "positional"],
      input.argv.map((value) => (value === "C:\\bharatcode-wsl-acceptance\\project" ? "C:\\work\\..\\private" : value)),
    ]) {
      expect(() => parseAcceptanceArguments(argv)).toThrow()
    }
  })

  test("admits only exact complete scenario observations", async () => {
    const input = await fixture()
    expect(parseAcceptanceObservation(input.observations["scenario-9"])).toEqual(input.observations["scenario-9"])
    expect(parseAcceptanceObservation(input.observations["scenario-10"])).toEqual(input.observations["scenario-10"])
    for (const hostile of [
      { ...input.observations["scenario-9"], raw_user: "alice" },
      { ...input.observations["scenario-9"], checks: { ...input.observations["scenario-9"].checks, non_root: false } },
      { ...input.observations["scenario-10"], checks: { ordinary_stop: true } },
      { ...input.observations["scenario-10"], wsl_version: 1 },
    ]) {
      expect(() => parseAcceptanceObservation(hostile)).toThrow()
    }
  })

  test("publishes a create-only closed secret-free receipt only for an authoritative GitHub Windows run", async () => {
    const input = await fixture()
    const result = await runWindowsAcceptance(input.argv, dependencies(input))
    expect(result.authority).toBe("PASS")
    expect(result.receiptPath).toBe(join(input.acceptanceDirectory, "scenarios-9-10.json"))
    expect(result.digestPath).toBe(join(input.acceptanceDirectory, "scenarios-9-10.json.sha256"))
    const receiptBytes = await readFile(result.receiptPath)
    const receipt = JSON.parse(receiptBytes.toString("utf8"))
    expect(receipt).toEqual({
      schema: "bharatcode-wsl-scenarios-9-10-v1",
      result: "PASS",
      source_sha: sourceSha,
      desktop_sha256: input.observations["scenario-9"].desktop_sha256,
      runtime_manifest_sha256: input.observations["scenario-9"].runtime_manifest_sha256,
      runtime: {
        manifest_source_sha: sourceSha,
        executed_source_sha: sourceSha,
        manifest_sha256: runtimeSha256,
        executed_sha256: runtimeSha256,
      },
      github: { run_id: 123456789, run_attempt: 2 },
      identity: {
        distro_sha256: input.observations["scenario-9"].distro_sha256,
        user_sha256: input.observations["scenario-9"].user_sha256,
        uid: 1000,
      },
      scenarios: { "9": true, "10": true },
      completed_at: completedAt,
    })
    expect(await readFile(result.digestPath, "utf8")).toBe(
      `${createHash("sha256").update(receiptBytes).digest("hex")}  scenarios-9-10.json\n`,
    )
    expect((await stat(result.receiptPath)).mode & 0o222).toBe(0)
    expect((await stat(result.digestPath)).mode & 0o222).toBe(0)
    expect(JSON.stringify(receipt)).not.toMatch(
      /alice|Ubuntu|Invalid Root|Missing Tool|bharatcode-wsl-acceptance|password|credential|token|pid|transport/iu,
    )
    await expect(runWindowsAcceptance(input.argv, dependencies(input))).rejects.toThrow("already exists")
  })

  test("keeps manual Windows runs diagnostic and never writes or returns PASS", async () => {
    const input = await fixture()
    const result = await runWindowsAcceptance(
      input.argv,
      dependencies(input, { env: { GITHUB_ACTIONS: "false", RUNNER_OS: "Windows" } }),
    )
    expect(result).toEqual({ authority: "DIAGNOSTIC", receiptPath: undefined, digestPath: undefined })
    expect(await Bun.file(join(input.acceptanceDirectory, "scenarios-9-10.json")).exists()).toBe(false)
    expect(await Bun.file(join(input.acceptanceDirectory, "scenarios-9-10.json.sha256")).exists()).toBe(false)
  })

  test("rejects non-Windows and non-canonical GitHub authority inputs", async () => {
    const input = await fixture()
    await expect(runWindowsAcceptance(input.argv, dependencies(input, { platform: "linux" }))).rejects.toThrow(
      "Windows",
    )
    for (const env of [
      { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
      { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", GITHUB_RUN_ID: "01", GITHUB_RUN_ATTEMPT: "1" },
      { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "0" },
      {
        GITHUB_ACTIONS: "true",
        RUNNER_OS: "Windows",
        GITHUB_RUN_ID: String(Number.MAX_SAFE_INTEGER + 1),
        GITHUB_RUN_ATTEMPT: "1",
      },
    ]) {
      await expect(runWindowsAcceptance(input.argv, dependencies(input, { env }))).rejects.toThrow()
    }
  })

  test("rejects invalid authoritative GitHub metadata before executing any case", async () => {
    const input = await fixture()
    let cases = 0
    await expect(
      runWindowsAcceptance(
        input.argv,
        dependencies(input, {
          env: {
            GITHUB_ACTIONS: "true",
            RUNNER_OS: "Windows",
            GITHUB_RUN_ID: "01",
            GITHUB_RUN_ATTEMPT: "1",
          },
          runCase: async () => {
            cases += 1
            return input.observations["scenario-9"]
          },
        }),
      ),
    ).rejects.toThrow("GITHUB_RUN_ID")
    expect(cases).toBe(0)
  })

  test("requires a positive Windows project attestation before WSL inspection or cases", async () => {
    const input = await fixture()
    let effects = 0
    await expect(
      runWindowsAcceptance(
        input.argv,
        dependencies(input, {
          verifyWindowsProject: async () => false,
          inspectWsl: async () => {
            effects += 1
            return []
          },
          runCase: async () => {
            effects += 1
            return input.observations["scenario-9"]
          },
        }),
      ),
    ).rejects.toThrow("project")
    expect(effects).toBe(0)
  })

  test("requires each named distribution to appear exactly once as WSL2", async () => {
    const input = await fixture()
    let cases = 0
    await expect(
      runWindowsAcceptance(
        input.argv,
        dependencies(input, {
          inspectWsl: async () => [
            { displayName: "Ubuntu 24.04", version: 2 },
            { displayName: "Ubuntu 24.04", version: 2 },
            { displayName: "Invalid Root", version: 2 },
            { displayName: "Missing Tool", version: 2 },
          ],
          runCase: async () => {
            cases += 1
            return input.observations["scenario-9"]
          },
        }),
      ),
    ).rejects.toThrow("exactly one")
    expect(cases).toBe(0)
  })

  test("rejects mutable, symlinked, unpackaged, source-drifted, and non-WSL2 inputs before cases", async () => {
    for (const mutate of [
      async (input: Awaited<ReturnType<typeof fixture>>) => chmod(input.desktopExe, 0o644),
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        const target = `${input.desktopExe}.target`
        await rm(input.desktopExe)
        await writeFile(target, "MZtarget", { mode: 0o444 })
        await symlink(target, input.desktopExe)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        await chmod(input.desktopExe, 0o644)
        await writeFile(input.desktopExe, "not-a-pe")
        await chmod(input.desktopExe, 0o444)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        input.argv[input.argv.indexOf("--source-sha") + 1] = "8".repeat(40)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => chmod(input.runtimeManifest, 0o644),
      async (input: Awaited<ReturnType<typeof fixture>>) => chmod(input.runtimePath, 0o644),
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        const target = `${input.runtimeManifest}.target`
        await writeFile(target, await readFile(input.runtimeManifest), { mode: 0o444 })
        await rm(input.runtimeManifest)
        await symlink(target, input.runtimeManifest)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        const target = `${input.runtimePath}.target`
        await writeFile(target, await readFile(input.runtimePath), { mode: 0o444 })
        await rm(input.runtimePath)
        await symlink(target, input.runtimePath)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => rm(input.runtimeManifest),
      async (input: Awaited<ReturnType<typeof fixture>>) => rm(input.runtimePath),
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        await rm(input.runtimeManifest)
        await mkdir(input.runtimeManifest)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        await rm(input.runtimePath)
        await mkdir(input.runtimePath)
      },
      async (input: Awaited<ReturnType<typeof fixture>>) => {
        await chmod(input.runtimePath, 0o644)
        await writeFile(input.runtimePath, Buffer.alloc(0))
        await chmod(input.runtimePath, 0o444)
      },
    ]) {
      const input = await fixture()
      let calls = 0
      await mutate(input)
      await expect(
        runWindowsAcceptance(
          input.argv,
          dependencies(input, {
            runCase: async () => {
              calls += 1
              return input.observations["scenario-9"]
            },
          }),
        ),
      ).rejects.toThrow()
      expect(calls).toBe(0)
    }

    const input = await fixture()
    let calls = 0
    await expect(
      runWindowsAcceptance(
        input.argv,
        dependencies(input, {
          inspectWsl: async () => [
            { displayName: "Ubuntu 24.04", version: 1 },
            { displayName: "Invalid Root", version: 2 },
            { displayName: "Missing Tool", version: 2 },
          ],
          runCase: async () => {
            calls += 1
            return input.observations["scenario-9"]
          },
        }),
      ),
    ).rejects.toThrow("WSL2")
    expect(calls).toBe(0)
  })

  test("writes no final receipt for an incomplete, mismatched, or failed case", async () => {
    for (const runCase of [
      async (input: Awaited<ReturnType<typeof fixture>>, name: keyof typeof input.observations) => {
        if (name === "scenario-10") throw new Error("case failed")
        return input.observations[name]
      },
      async (input: Awaited<ReturnType<typeof fixture>>, name: keyof typeof input.observations) => ({
        ...input.observations[name],
        executed_source_sha: "8".repeat(40),
      }),
      async (input: Awaited<ReturnType<typeof fixture>>, name: keyof typeof input.observations) => ({
        ...input.observations[name],
        checks: { ...input.observations[name].checks, [Object.keys(input.observations[name].checks)[0]]: false },
      }),
    ]) {
      const input = await fixture()
      await expect(
        runWindowsAcceptance(
          input.argv,
          dependencies(input, {
            runCase: ({ case: name }: { case: keyof typeof input.observations }) => runCase(input, name),
          }),
        ),
      ).rejects.toThrow()
      expect(await Bun.file(join(input.acceptanceDirectory, "scenarios-9-10.json")).exists()).toBe(false)
      expect(await Bun.file(join(input.acceptanceDirectory, "scenarios-9-10.json.sha256")).exists()).toBe(false)
    }
  })

  test("rejects preexisting receipt or digest before inspecting WSL or executing a case", async () => {
    for (const filename of ["scenarios-9-10.json", "scenarios-9-10.json.sha256"]) {
      const input = await fixture()
      await writeFile(join(input.acceptanceDirectory, filename), "preseeded")
      let effects = 0
      await expect(
        runWindowsAcceptance(
          input.argv,
          dependencies(input, {
            inspectWsl: async () => {
              effects += 1
              return []
            },
            runCase: async () => {
              effects += 1
              return input.observations["scenario-9"]
            },
          }),
        ),
      ).rejects.toThrow("already exists")
      expect(effects).toBe(0)
    }
  })

  test("ignores only the local acceptance directory and introduces no workflow seam", async () => {
    const ignore = await Bun.file(resolve(import.meta.dir, "../.gitignore")).text()
    expect(ignore).toContain(".artifacts/wsl-acceptance/")
    const source = await Bun.file(new URL("./wsl-windows-acceptance.mjs", import.meta.url)).text()
    expect(source).not.toMatch(/upload|artifact client|workflow_dispatch|release|cohort|signing/iu)
    expect((await stat(resolve(import.meta.dir, "..", ".gitignore"))).isFile()).toBe(true)
  })
})
