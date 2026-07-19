const MAX_RECORD_BYTES = 8_192
const MAX_OUTPUT_RECORDS = 4_096

export function resolveWslBuildSourceSha(env: Readonly<Record<string, string | undefined>>, wslCandidate: boolean) {
  const value = env.BHARATCODE_SOURCE_SHA
  if (value === undefined && !wslCandidate) return "unavailable" as const
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("WSL candidate builds require exact BHARATCODE_SOURCE_SHA")
  }
  return value
}

export type WslDesktopStart = {
  type: "start"
  hostname: "127.0.0.1"
  port: number
  started_at_ms: number
  username: string
  password: string
}

export type WslDesktopInput = WslDesktopStart | { type: "stop" }

export type WslDesktopIdentity = {
  type: "identity"
  source_sha: string
  version: string
  executable_sha256: string
  uid: number
}

export type WslDesktopOutput =
  | WslDesktopIdentity
  | { type: "sqlite"; progress: { type: "InProgress"; value: number } | { type: "Done" } }
  | { type: "ready" }
  | { type: "error"; code: "protocol" | "start-failed" | "stop-failed" }
  | { type: "stopped" }

type WslDesktopRecord = WslDesktopInput | WslDesktopOutput

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonical(line: string) {
  if (!line || new TextEncoder().encode(line).byteLength > MAX_RECORD_BYTES)
    throw new Error("WSL stdio record exceeds 8192 bytes")
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("WSL stdio record is not valid JSON")
  }
  if (JSON.stringify(value) !== line) throw new Error("WSL stdio record is not canonical JSON")
  return value
}

export function decodeWslDesktopInput(line: string): WslDesktopInput {
  const value = canonical(line)
  if (exact(value, ["type"]) && value.type === "stop") return { type: "stop" }
  if (!exact(value, ["type", "hostname", "port", "started_at_ms", "username", "password"])) {
    throw new Error("WSL stdio input uses an unknown record shape")
  }
  if (value.type !== "start" || value.hostname !== "127.0.0.1") throw new Error("WSL stdio start is not loopback")
  if (typeof value.port !== "number" || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("WSL stdio start port is invalid")
  }
  if (
    typeof value.started_at_ms !== "number" ||
    !Number.isSafeInteger(value.started_at_ms) ||
    value.started_at_ms <= 0
  ) {
    throw new Error("WSL stdio start time is invalid")
  }
  if (typeof value.username !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(value.username)) {
    throw new Error("WSL stdio username is invalid")
  }
  if (
    typeof value.password !== "string" ||
    value.password.length < 1 ||
    value.password.length > 512 ||
    /[\u0000\r\n]/u.test(value.password)
  ) {
    throw new Error("WSL stdio password is invalid")
  }
  return {
    type: "start",
    hostname: "127.0.0.1",
    port: value.port,
    started_at_ms: value.started_at_ms,
    username: value.username,
    password: value.password,
  }
}

export function decodeWslDesktopOutput(line: string): WslDesktopOutput {
  const value = canonical(line)
  if (exact(value, ["type"])) {
    if (value.type === "ready") return { type: "ready" }
    if (value.type === "stopped") return { type: "stopped" }
  }
  if (exact(value, ["type", "code"]) && value.type === "error") {
    if (!["protocol", "start-failed", "stop-failed"].includes(String(value.code))) {
      throw new Error("WSL stdio error code is invalid")
    }
    return value as WslDesktopOutput
  }
  if (exact(value, ["type", "source_sha", "version", "executable_sha256", "uid"]) && value.type === "identity") {
    if (typeof value.source_sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.source_sha)) {
      throw new Error("WSL stdio identity source SHA is invalid")
    }
    if (typeof value.version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version)) {
      throw new Error("WSL stdio identity version is invalid")
    }
    if (typeof value.executable_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.executable_sha256)) {
      throw new Error("WSL stdio identity digest is invalid")
    }
    if (typeof value.uid !== "number" || !Number.isSafeInteger(value.uid) || value.uid <= 0) {
      throw new Error("WSL stdio identity UID is invalid")
    }
    return {
      type: "identity",
      source_sha: value.source_sha,
      version: value.version,
      executable_sha256: value.executable_sha256,
      uid: value.uid,
    }
  }
  if (exact(value, ["type", "progress"]) && value.type === "sqlite") {
    if (exact(value.progress, ["type"]) && value.progress.type === "Done") {
      return { type: "sqlite", progress: { type: "Done" } }
    }
    if (exact(value.progress, ["type", "value"]) && value.progress.type === "InProgress") {
      if (
        typeof value.progress.value !== "number" ||
        !Number.isSafeInteger(value.progress.value) ||
        value.progress.value < 0 ||
        value.progress.value > 100
      ) {
        throw new Error("WSL stdio sqlite progress is invalid")
      }
      return { type: "sqlite", progress: { type: "InProgress", value: value.progress.value } }
    }
  }
  throw new Error("WSL stdio output uses an unknown record shape")
}

export function encodeWslDesktopRecord(record: WslDesktopRecord) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`)
  if (bytes.byteLength - 1 > MAX_RECORD_BYTES) throw new Error("WSL stdio record exceeds 8192 bytes")
  return bytes
}

export async function* readWslDesktopLines(input: AsyncIterable<Uint8Array>) {
  const pending: number[] = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for await (const chunk of input) {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        let line: string
        try {
          line = decoder.decode(new Uint8Array(pending))
        } catch {
          throw new Error("WSL stdio record is not valid UTF-8")
        }
        pending.length = 0
        yield line
        continue
      }
      pending.push(byte)
      if (pending.length > MAX_RECORD_BYTES) throw new Error("WSL stdio record exceeds 8192 bytes")
    }
  }
  if (pending.length !== 0) throw new Error("WSL stdio ended with a truncated record")
}

export async function runWslDesktopTransport(input: {
  expectedHostname: "127.0.0.1"
  expectedPort: number
  input: AsyncIterable<Uint8Array>
  identity: () => Promise<WslDesktopIdentity>
  listen: (options: { hostname: string; port: number; username: string; password: string }) => Promise<{
    stop: () => Promise<void>
  }>
  writeStdout: (record: Uint8Array) => Promise<void>
  writeStderr: (message: string) => void
}) {
  let listener: Awaited<ReturnType<typeof input.listen>> | undefined
  let started = false
  let terminal = false
  let count = 0
  const emit = async (record: WslDesktopOutput) => {
    count += 1
    if (count > MAX_OUTPUT_RECORDS) throw new Error("WSL stdio output record limit exceeded")
    if (record.type === "error" || record.type === "stopped") {
      if (terminal) throw new Error("WSL stdio emitted duplicate terminal result")
      terminal = true
    }
    await input.writeStdout(encodeWslDesktopRecord(record))
  }
  const stop = async () => {
    if (!listener) return
    const active = listener
    listener = undefined
    await active.stop()
  }

  try {
    for await (const line of readWslDesktopLines(input.input)) {
      const command = decodeWslDesktopInput(line)
      if (!started) {
        if (command.type !== "start") throw new Error("WSL stdio requires start first")
        if (command.hostname !== input.expectedHostname || command.port !== input.expectedPort) {
          throw new Error("WSL stdio start does not match the command line")
        }
        await emit(await input.identity())
        listener = await input.listen({
          hostname: command.hostname,
          port: command.port,
          username: command.username,
          password: command.password,
        })
        started = true
        await emit({ type: "ready" })
        continue
      }
      if (command.type !== "stop") throw new Error("WSL stdio accepts exactly one start")
      await stop()
      await emit({ type: "stopped" })
      return
    }
    if (!started) throw new Error("WSL stdio ended before start")
    await stop()
    await emit({ type: "stopped" })
  } catch (error) {
    const stopFailed = await stop().then(
      () => false,
      () => true,
    )
    input.writeStderr("BharatCode WSL stdio session failed")
    if (!terminal)
      await emit({ type: "error", code: stopFailed ? "stop-failed" : started ? "protocol" : "start-failed" })
    if (error instanceof Error && error.message === "WSL stdio output record limit exceeded") throw error
  }
}
