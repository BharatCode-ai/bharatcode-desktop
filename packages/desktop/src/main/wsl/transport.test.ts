import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { connectWslChild } from "./transport"

const identity = {
  type: "identity" as const,
  source_sha: "1".repeat(40),
  version: "1.15.35",
  channel: "beta" as const,
  executable_sha256: "2".repeat(64),
  uid: 1000,
}
const password = "synthetic-control-secret"

function fixture(records: unknown[] = [identity, { type: "ready" }], stop = true) {
  return spawn(
    process.execPath,
    [
      "-e",
      `
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", data => {
      buffer += data;
      while (buffer.includes("\\n")) {
        const split = buffer.indexOf("\\n");
        const command = JSON.parse(buffer.slice(0, split));
        buffer = buffer.slice(split + 1);
        if (command.type === "start") {
          if (Object.values(process.env).includes(command.password) || process.argv.includes(command.password)) process.exit(3);
          for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record) + "\\n");
        } else if (${stop}) {
          process.stdout.write(JSON.stringify({type:"stopped"})+"\\n", () => process.exit(0));
        }
      }
    });
    setInterval(() => {}, 1000);
  `,
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] },
  )
}

const health: typeof fetch = async (_input, init) =>
  new Response(null, {
    status: new Headers(init?.headers).get("authorization") === `Basic ${btoa(`bharatcode:${password}`)}` ? 200 : 401,
  })

test("typed child handshake verifies identity and credentials; stop is acknowledged and idempotent", async () => {
  const child = fixture()
  try {
    const listener = await connectWslChild(child, { identity, password, port: 43210, fetch: health })
    const exited = Promise.withResolvers<void>()
    listener.onExit((code) => {
      expect(code).toBe(0)
      exited.resolve()
    })
    const stop = listener.stop()
    expect(listener.stop()).toBe(stop)
    await stop
    await exited.promise
    let late = false
    listener.onExit(() => {
      late = true
    })
    expect(late).toBe(true)
  } finally {
    child.kill()
  }
})

for (const records of [
  [{ type: "ready" }],
  [{ ...identity, source_sha: "3".repeat(40) }, { type: "ready" }],
  [{ ...identity, uid: 0 }, { type: "ready" }],
  [{ ...identity, channel: "prod" }, { type: "ready" }],
  [identity, identity, { type: "ready" }],
  [identity, { type: "stopped" }],
  [identity, { type: "error", code: "start-failed" }],
  [{ ...identity, leaked: password }],
]) {
  test(`rejects invalid protocol before granting runtime authority: ${JSON.stringify(records).slice(0, 80)}`, async () => {
    const child = fixture(records)
    try {
      await expect(
        connectWslChild(child, { identity, password, port: 43210, fetch: health, timeoutMs: 2000 }),
      ).rejects.toThrow("WSL runtime startup failed")
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      child.kill()
    }
  })
}

test("rejects an anonymous health success and terminates the child", async () => {
  const child = fixture()
  try {
    await expect(
      connectWslChild(child, {
        identity,
        password,
        port: 43210,
        fetch: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toThrow("WSL runtime startup failed")
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  } finally {
    child.kill()
  }
})

test("startup timeout cancels health and cleans up the process", async () => {
  const child = fixture()
  let cancelled = false
  try {
    await expect(
      connectWslChild(child, {
        identity,
        password,
        port: 43210,
        timeoutMs: 100,
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                cancelled = true
                reject(new Error(password))
              },
              { once: true },
            )
          }),
      }),
    ).rejects.toThrow("WSL runtime startup failed")
    expect(cancelled).toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  } finally {
    child.kill()
  }
})

test("shutdown without acknowledgement is a bounded failure, not a successful stop", async () => {
  const child = fixture(undefined, false)
  try {
    const listener = await connectWslChild(child, { identity, password, port: 43210, fetch: health })
    await expect(listener.stop()).rejects.toThrow("WSL runtime shutdown failed")
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  } finally {
    child.kill()
  }
}, 15_000)
