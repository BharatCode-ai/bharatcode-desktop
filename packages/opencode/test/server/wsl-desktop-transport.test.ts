import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  decodeWslDesktopInput,
  decodeWslDesktopOutput,
  encodeWslDesktopRecord,
  readWslDesktopLines,
  resolveWslBuildSourceSha,
  runWslDesktopTransport,
  type WslDesktopIdentity,
} from "@/server/wsl-desktop-transport"

const sourceSha = "9".repeat(40)
const executableSha256 = "8".repeat(64)
const secret = "stdio-only-secret"
const identity: WslDesktopIdentity = {
  type: "identity",
  source_sha: sourceSha,
  version: "1.15.21",
  executable_sha256: executableSha256,
  uid: 1000,
}

function chunks(...records: Array<string | Uint8Array>) {
  return (async function* () {
    for (const record of records) yield typeof record === "string" ? new TextEncoder().encode(record) : record
  })()
}

describe("WSL Desktop bounded JSONL transport", () => {
  test("accepts only canonical closed input and output records", () => {
    const start = {
      type: "start" as const,
      hostname: "127.0.0.1" as const,
      port: 43123,
      started_at_ms: 1_721_000_000_000,
      username: "bharatcode",
      password: secret,
    }
    expect(decodeWslDesktopInput(JSON.stringify(start))).toEqual(start)
    expect(decodeWslDesktopInput('{"type":"stop"}')).toEqual({ type: "stop" })
    expect(decodeWslDesktopOutput(JSON.stringify(identity))).toEqual(identity)

    for (const line of [
      '{"type":"stop","extra":true}',
      '{"type":"stop","type":"stop"}',
      '{ "type":"stop"}',
      '{"type":"start","hostname":"0.0.0.0","port":43123,"started_at_ms":1721000000000,"username":"bharatcode","password":"x"}',
      '{"type":"ready","extra":true}',
      "not-json",
      "",
    ]) {
      expect(() => decodeWslDesktopInput(line)).toThrow()
    }
    expect(() => decodeWslDesktopOutput('{"type":"identity","source_sha":"bad"}')).toThrow()
  })

  test("frames fatal UTF-8 records at 8192 bytes and rejects oversize or truncated input", async () => {
    const stop = encodeWslDesktopRecord({ type: "stop" })
    const framed: string[] = []
    for await (const line of readWslDesktopLines(chunks(stop.slice(0, 4), stop.slice(4)))) framed.push(line)
    expect(framed).toEqual(['{"type":"stop"}'])

    await expect(async () => {
      for await (const _line of readWslDesktopLines(chunks(`"${"x".repeat(8192)}"\n`))) void _line
    }).toThrow("8192")
    await expect(async () => {
      for await (const _line of readWslDesktopLines(chunks('{"type":"stop"}'))) void _line
    }).toThrow("truncated")
    await expect(async () => {
      for await (const _line of readWslDesktopLines(chunks(new Uint8Array([0xff, 0x0a])))) void _line
    }).toThrow("UTF-8")
  })

  test("emits protocol-only identity, ready, and one terminal result while credentials reach only listen", async () => {
    const stdout: Uint8Array[] = []
    const stderr: string[] = []
    const listens: unknown[] = []
    let stops = 0
    await runWslDesktopTransport({
      expectedHostname: "127.0.0.1",
      expectedPort: 43123,
      input: chunks(
        `${JSON.stringify({
          type: "start",
          hostname: "127.0.0.1",
          port: 43123,
          started_at_ms: 1_721_000_000_000,
          username: "bharatcode",
          password: secret,
        })}\n`,
        '{"type":"stop"}\n',
      ),
      identity: async () => identity,
      listen: async (options) => {
        listens.push(options)
        return { stop: async () => void (stops += 1) }
      },
      writeStdout: async (record) => void stdout.push(record.slice()),
      writeStderr: (message) => stderr.push(message),
    })

    const records = new TextDecoder()
      .decode(Buffer.concat(stdout.map((item) => Buffer.from(item))))
      .trimEnd()
      .split("\n")
      .map(decodeWslDesktopOutput)
    expect(records).toEqual([identity, { type: "ready" }, { type: "stopped" }])
    expect(listens).toEqual([{ hostname: "127.0.0.1", port: 43123, username: "bharatcode", password: secret }])
    expect(stops).toBe(1)
    expect(JSON.stringify({ stdout: records, stderr })).not.toContain(secret)
  })

  test("treats EOF as stop and fails duplicate starts with one closed terminal error", async () => {
    const start = `${JSON.stringify({
      type: "start",
      hostname: "127.0.0.1",
      port: 43123,
      started_at_ms: 1_721_000_000_000,
      username: "bharatcode",
      password: secret,
    })}\n`
    const run = async (input: AsyncIterable<Uint8Array>) => {
      const stdout: Uint8Array[] = []
      await runWslDesktopTransport({
        expectedHostname: "127.0.0.1",
        expectedPort: 43123,
        input,
        identity: async () => identity,
        listen: async () => ({ stop: async () => undefined }),
        writeStdout: async (record) => void stdout.push(record.slice()),
        writeStderr: () => undefined,
      })
      return new TextDecoder()
        .decode(Buffer.concat(stdout.map((item) => Buffer.from(item))))
        .trimEnd()
        .split("\n")
        .map(decodeWslDesktopOutput)
    }

    expect(await run(chunks(start))).toEqual([identity, { type: "ready" }, { type: "stopped" }])
    const duplicate = await run(chunks(start, start))
    expect(duplicate.at(-1)).toEqual({ type: "error", code: "protocol" })
    expect(duplicate.filter((record) => record.type === "error" || record.type === "stopped")).toHaveLength(1)
  })

  test("serve exposes only the hidden stdio adapter and keeps ordinary logging out of that branch", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../../src/cli/cmd/serve.ts")).text()
    expect(source).toContain('"desktop-sidecar-stdio"')
    expect(source).toContain("runWslDesktopTransport")
    expect(source).toContain("runtimeIdentity")
    expect(source).toContain("if (args.desktopSidecarStdio)")
    expect(source.indexOf("if (args.desktopSidecarStdio)")).toBeLessThan(source.indexOf("console.log"))
    expect(source).toContain("BHARATCODE_WSL_COMPILED_SOURCE_SHA")
    expect(source).not.toContain("OPENCODE_SOURCE_SHA")
    expect(source).not.toContain("process.env.BHARATCODE_SOURCE_SHA")
  })

  test("production build injects only an exact branded WSL candidate source identity", async () => {
    expect(resolveWslBuildSourceSha({}, false)).toBe("unavailable")
    expect(resolveWslBuildSourceSha({ BHARATCODE_SOURCE_SHA: sourceSha }, true)).toBe(sourceSha)
    for (const env of [{}, { BHARATCODE_SOURCE_SHA: "A".repeat(40) }, { BHARATCODE_SOURCE_SHA: "short" }]) {
      expect(() => resolveWslBuildSourceSha(env, true)).toThrow("BHARATCODE_SOURCE_SHA")
    }

    const build = await Bun.file(resolve(import.meta.dir, "../../script/build.ts")).text()
    expect(build).toContain('process.argv.includes("--wsl-candidate")')
    expect(build).toContain("resolveWslBuildSourceSha")
    expect(build).toContain("BHARATCODE_WSL_COMPILED_SOURCE_SHA")
  })

  test("an unavailable compiled source fails with a closed error before listen", async () => {
    const stdout: Uint8Array[] = []
    let listens = 0
    await runWslDesktopTransport({
      expectedHostname: "127.0.0.1",
      expectedPort: 43123,
      input: chunks(
        `${JSON.stringify({
          type: "start",
          hostname: "127.0.0.1",
          port: 43123,
          started_at_ms: 1_721_000_000_000,
          username: "bharatcode",
          password: secret,
        })}\n`,
      ),
      identity: async () => {
        throw new Error("unavailable compiled source")
      },
      listen: async () => {
        listens += 1
        return { stop: async () => undefined }
      },
      writeStdout: async (record) => void stdout.push(record.slice()),
      writeStderr: () => undefined,
    })
    expect(listens).toBe(0)
    expect(decodeWslDesktopOutput(new TextDecoder().decode(stdout[0]).trimEnd())).toEqual({
      type: "error",
      code: "start-failed",
    })
  })
})
