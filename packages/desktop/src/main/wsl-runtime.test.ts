import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import type { WslDesktopIdentity, WslDesktopOutput } from "../../../opencode/src/server/wsl-desktop-transport"
import {
  createWslRuntimeProtocolGate,
  resolveWslLaunchIdentity,
  startWslRuntime,
  type WslRuntimeSpawn,
} from "./wsl-runtime"

const sourceSha = "9".repeat(40)
const executable = Buffer.from("external-glibc-runtime")
const executableSha256 = createHash("sha256").update(executable).digest("hex")
const secret = "main-stdin-only-secret"
const filename = "bharatcode-runtime-linux-x64-glibc"
const version = "1.15.21"
const installedPath = `/home/alice/.cache/bharatcode-beta/bin/${filename}`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function artifact() {
  const root = await mkdtemp(join(tmpdir(), "bharatcode-wsl-runtime-"))
  roots.push(root)
  const runtimePath = join(root, filename)
  const manifestPath = join(root, "manifest.json")
  await writeFile(runtimePath, executable, { mode: 0o444 })
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schema: 1,
      source_sha: sourceSha,
      version,
      arch: "x64",
      filename,
      bytes: executable.byteLength,
      sha256: executableSha256,
    })}\n`,
    { mode: 0o444 },
  )
  await chmod(runtimePath, 0o444)
  await chmod(manifestPath, 0o444)
  return { runtimePath, manifestPath }
}

function identity(overrides: Partial<WslDesktopIdentity> = {}): WslDesktopIdentity {
  return {
    type: "identity",
    source_sha: sourceSha,
    version,
    executable_sha256: executableSha256,
    uid: 1000,
    ...overrides,
  }
}

function childHarness(
  records: WslDesktopOutput[] = [identity(), { type: "ready" }],
  stderrText = "",
  exitOnStop = true,
) {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const writes: Array<{ retained: Buffer; observed: Buffer }> = []
  let commands = 0
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const retained = chunk
      const observed = Buffer.from(chunk)
      writes.push({ retained, observed })
      commands += 1
      callback()
      queueMicrotask(() => {
        if (commands === 1) {
          if (stderrText) stderr.write(stderrText)
          for (const record of records) stdout.write(`${JSON.stringify(record)}\n`)
          return
        }
        stdout.write('{"type":"stopped"}\n')
        stdout.end()
        stderr.end()
        if (exitOnStop) events.emit("exit", 0, null)
      })
    },
    final(callback) {
      stdout.end()
      stderr.end()
      events.emit("exit", 0, null)
      callback()
    },
  })
  return {
    child: Object.assign(events, { stdin, stdout, stderr }),
    writes,
    exit: (code = 0) => events.emit("exit", code, null),
  }
}

async function runtimeInput(options?: {
  records?: WslDesktopOutput[]
  stderr?: string
  exitOnStop?: boolean
  spawnCalls?: Array<{ executable: string; args: readonly string[]; options: unknown }>
  healthCalls?: Array<{ url: string; username?: string | null; password?: string | null }>
}) {
  const files = await artifact()
  const harness = childHarness(options?.records, options?.stderr, options?.exitOnStop)
  const runtimeWindowsPath = `C:\\Program Files\\BharatCode\\resources\\wsl-runtime\\${filename}`
  const execute = async (_executable: string, args: readonly string[]) => {
    if (args.includes("/usr/bin/wslpath") && args.includes("--unix")) {
      return { stdout: `/mnt/c/Program Files/BharatCode/resources/wsl-runtime/${filename}\n` }
    }
    if (args.includes("/usr/bin/wslpath") && args.includes("--windows")) return { stdout: `${runtimeWindowsPath}\r\n` }
    if (args.includes("/usr/bin/findmnt")) return { stdout: "/mnt/c 9p\n" }
    if (args.includes("/usr/bin/sha256sum")) return { stdout: `${executableSha256} *${installedPath}\n` }
    if (args.includes("/usr/bin/stat")) return { stdout: `${executable.byteLength}\n` }
    return { stdout: "" }
  }
  const spawn: WslRuntimeSpawn = (executable, args, spawnOptions) => {
    options?.spawnCalls?.push({ executable, args, options: spawnOptions })
    return harness.child
  }
  return {
    harness,
    input: {
      wslExecutable: "C:\\Windows\\System32\\wsl.exe",
      execute,
      spawn,
      selectedDisplayName: "Ubuntu 24.04",
      selectedUser: "alice",
      selectedUid: 1000,
      home: "/home/alice",
      channel: "beta",
      port: 43123,
      startedAtMs: 1_721_000_000_000,
      password: secret,
      runtimePath: files.runtimePath,
      runtimeWindowsPath,
      manifestPath: files.manifestPath,
      expectedSourceSha: sourceSha,
      expectedVersion: version,
      expectedArch: "x64" as const,
      hostEnv: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", PRIVATE_TOKEN: secret },
      healthCheck: async (url: string, username?: string | null, password?: string | null) => {
        options?.healthCalls?.push({ url, username, password })
        return password === secret
      },
      onStderr: (_message: string) => undefined,
    },
  }
}

describe("selected-distro WSL runtime", () => {
  test("resolves the selected default user, UID, and home with fixed argument arrays", async () => {
    const calls: readonly string[][] = []
    const execute = async (_executable: string, args: readonly string[]) => {
      ;(calls as string[][]).push([...args])
      if (args.includes("--user")) return { stdout: "1000\n" }
      if (args.includes("--un")) return { stdout: "alice\n" }
      return { stdout: "alice:x:1000:1000:Alice:/home/alice:/bin/bash\n" }
    }
    expect(
      await resolveWslLaunchIdentity({
        wslExecutable: "C:\\Windows\\System32\\wsl.exe",
        selectedDisplayName: "Ubuntu 24.04",
        execute,
      }),
    ).toEqual({ user: "alice", uid: 1000, home: "/home/alice" })
    expect(calls).toEqual([
      ["--distribution", "Ubuntu 24.04", "--exec", "/usr/bin/id", "--user"],
      ["--distribution", "Ubuntu 24.04", "--exec", "/usr/bin/id", "--un"],
      ["--distribution", "Ubuntu 24.04", "--exec", "/usr/bin/getent", "passwd", "alice"],
    ])
    expect(JSON.stringify(calls)).not.toMatch(/\/bin\/(?:ba)?sh|-c/)

    await expect(
      resolveWslLaunchIdentity({
        wslExecutable: "C:\\Windows\\System32\\wsl.exe",
        selectedDisplayName: "Ubuntu 24.04",
        execute: async (_executable, args) => ({ stdout: args.includes("--user") ? "0\n" : "root\n" }),
      }),
    ).rejects.toThrow("non-root")
  })

  test("verifies, installs, launches with fixed env, authenticates health, and zeroes the start buffer", async () => {
    const spawnCalls: Array<{ executable: string; args: readonly string[]; options: unknown }> = []
    const healthCalls: Array<{ url: string; username?: string | null; password?: string | null }> = []
    const target = await runtimeInput({ spawnCalls, healthCalls })
    const runtime = await startWslRuntime(target.input)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].executable).toBe("C:\\Windows\\System32\\wsl.exe")
    expect(spawnCalls[0].args).toEqual([
      "--distribution",
      "Ubuntu 24.04",
      "--user",
      "alice",
      "--cd",
      "/home/alice",
      "--exec",
      "/usr/bin/env",
      "-i",
      "HOME=/home/alice",
      "USER=alice",
      "LOGNAME=alice",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "BHARATCODE_CHANNEL=beta",
      "TMPDIR=/tmp",
      installedPath,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "43123",
      "--desktop-sidecar-stdio",
    ])
    expect(JSON.stringify(spawnCalls)).not.toContain(secret)
    expect(spawnCalls[0].options).toMatchObject({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    expect(target.harness.writes[0].observed.toString("utf8")).toContain(secret)
    expect([...target.harness.writes[0].retained]).toEqual(Array(target.harness.writes[0].retained.length).fill(0))
    expect(healthCalls).toEqual([
      { url: "http://127.0.0.1:43123" },
      { url: "http://127.0.0.1:43123", username: "bharatcode", password: secret },
    ])
    expect(runtime.identity).toEqual(identity())
    expect(
      runtime.authorization.authorize("http://127.0.0.1:43123/global/health", new Headers()).get("authorization"),
    ).toBe(`Basic ${Buffer.from(`bharatcode:${secret}`).toString("base64")}`)
    expect(JSON.stringify(runtime)).not.toContain(secret)

    await runtime.stop()
    expect(target.harness.writes[1].observed.toString("utf8")).toBe('{"type":"stop"}\n')
  })

  test("rejects source, version, digest, or UID mismatch before authenticated health", async () => {
    for (const mismatch of [
      { source_sha: "7".repeat(40) },
      { version: "1.15.22" },
      { executable_sha256: "6".repeat(64) },
      { uid: 1001 },
    ]) {
      const healthCalls: Array<{ url: string }> = []
      const target = await runtimeInput({ records: [identity(mismatch), { type: "ready" }], healthCalls })
      await expect(startWslRuntime(target.input)).rejects.toThrow("identity")
      expect(healthCalls).toHaveLength(0)
    }
  })

  test("does not accept ready followed immediately by a terminal failure", async () => {
    for (const terminal of [{ type: "error", code: "start-failed" } as const, { type: "stopped" } as const]) {
      const target = await runtimeInput({ records: [identity(), { type: "ready" }, terminal] })
      await expect(startWslRuntime(target.input)).rejects.toThrow(/runtime|terminal|stopped/i)
    }
  })

  test("rejects duplicate, out-of-order, excessive, and non-protocol stdout", () => {
    const expected = { sourceSha, version, executableSha256, uid: 1000 }
    for (const records of [
      [{ type: "ready" } as const],
      [identity(), identity()],
      [identity(), { type: "ready" } as const, { type: "ready" } as const],
      [identity(), { type: "stopped" } as const, { type: "stopped" } as const],
    ]) {
      const gate = createWslRuntimeProtocolGate(expected)
      expect(() => records.forEach((record) => gate.accept(record))).toThrow()
    }
    const gate = createWslRuntimeProtocolGate(expected)
    gate.accept(identity())
    for (let index = 1; index < 4_096; index += 1) {
      gate.accept({ type: "sqlite", progress: { type: "InProgress", value: index % 101 } })
    }
    expect(() => gate.accept({ type: "ready" })).toThrow("4096")
  })

  test("keeps the password out of stderr, logs, status, IPC, preload, renderer, and persistence surfaces", async () => {
    const logs: string[] = []
    const target = await runtimeInput({ stderr: secret })
    target.input.onStderr = (message) => logs.push(message)
    await expect(startWslRuntime(target.input)).rejects.toThrow("credential")
    expect(JSON.stringify(logs)).not.toContain(secret)

    for (const file of ["ipc.ts", "../preload/index.ts", "../preload/types.ts", "../renderer/index.tsx", "store.ts"]) {
      expect(await Bun.file(join(import.meta.dir, file)).text()).not.toContain(secret)
    }
  })

  test("wires enabled startup through WSL and makes redirected health fail closed", async () => {
    const server = await Bun.file(join(import.meta.dir, "server.ts")).text()
    const index = await Bun.file(join(import.meta.dir, "index.ts")).text()
    expect(server).toContain("spawnWslServer")
    expect(server).toContain("startWslRuntime")
    expect(server).toContain('redirect: "error"')
    expect(index).toContain("spawnWslServer")
    expect(index).toContain("wslSnapshot.enabled")
    expect(index).not.toContain("sidecar start record")
  })

  test("closed stop is idempotent, waits for child exit, and EOF closes only stdin", async () => {
    const target = await runtimeInput({ exitOnStop: false })
    const runtime = await startWslRuntime(target.input)
    let settled = false
    const first = runtime.stop()
    const second = runtime.stop()
    expect(first).toBe(second)
    void first.then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(
      target.harness.writes.filter((write) => write.observed.toString("utf8") === '{"type":"stop"}\n'),
    ).toHaveLength(1)
    target.harness.exit()
    await Promise.all([first, second, runtime.exited])

    const eofTarget = await runtimeInput({ exitOnStop: false })
    const eofRuntime = await startWslRuntime(eofTarget.input)
    eofRuntime.closeInput()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(eofTarget.harness.writes).toHaveLength(1)
    await eofRuntime.exited
  })
})
