import { expect, test } from "bun:test"
import { Console } from "node:console"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import { guardConsolePipe } from "./stdio"

test("healthy console writes and callbacks are unchanged", async () => {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString())
      done()
    },
  })
  guardConsolePipe(stream)
  const console = new Console({ stdout: stream, stderr: stream, ignoreErrors: false })
  console.warn("warning %s", "stays visible")
  await new Promise<void>((resolve, reject) => stream.write("callback", (error) => (error ? reject(error) : resolve())))
  expect(chunks).toEqual(["warning stays visible\n", "callback"])
})

test("synchronous EPIPE stops only that console sink; callbacks do not hang", async () => {
  const stream = new Writable()
  let writes = 0
  stream.write = () => {
    writes++
    throw Object.assign(new Error("closed"), { code: "EPIPE" })
  }
  guardConsolePipe(stream)
  const console = new Console({ stdout: stream, stderr: stream, ignoreErrors: false })
  expect(() => console.warn("first")).not.toThrow()
  expect(() => console.warn("second")).not.toThrow()
  await new Promise<void>((resolve) => stream.write("discard", resolve))
  await new Promise<void>((resolve) => stream.write("discard", "utf8", resolve))
  expect(writes).toBe(1)
})

test("healthy stream backpressure still signals drain", async () => {
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      setImmediate(done)
    },
  })
  guardConsolePipe(stream)
  const drained = once(stream, "drain")
  expect(stream.write("buffered")).toBe(false)
  await drained
  expect(stream.writableLength).toBe(0)
})

test("asynchronous and repeated EPIPE are handled, without a global exception handler", async () => {
  const stream = new Writable({
    write(_chunk, _encoding, done) {
      process.nextTick(done, Object.assign(new Error("closed"), { code: "EPIPE" }))
    },
  })
  guardConsolePipe(stream)
  const failed = new Promise<void>((resolve) => stream.once("error", () => resolve()))
  const callback = new Promise<Error | null | undefined>((resolve) => stream.write("warning", resolve))
  await failed
  expect(await callback).toMatchObject({ code: "EPIPE" })
  expect(() => stream.emit("error", Object.assign(new Error("again"), { code: "EPIPE" }))).not.toThrow()
  await new Promise<void>((resolve) => stream.write("later", resolve))
})

test("other stream and synchronous errors are still raised", () => {
  const stream = new Writable()
  const error = Object.assign(new Error("unexpected"), { code: "EACCES" })
  stream.write = () => {
    throw error
  }
  guardConsolePipe(stream)
  expect(() => stream.write("warning")).toThrow(error)
  expect(() => stream.emit("error", error)).toThrow(error)
  stream.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }))
  expect(() => stream.emit("error", error)).toThrow(error)
})

test("compiled guard survives real Node stdout and stderr pipe disconnects", async () => {
  const parent = await realpath(tmpdir())
  const home = await mkdtemp(join(parent, "bharatcode-stdio-test-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("./stdio.ts"))],
      outdir: home,
      target: "node",
      format: "esm",
      naming: "stdio.mjs",
    })
    expect(build.success).toBe(true)
    for (const [target, guarded] of [
      ["stdout", false],
      ["stderr", false],
      ["stdout", true],
      ["stderr", true],
    ] as const) {
      const child = spawn(
        "node",
        [
          "--input-type=module",
          "-e",
          `
        import assert from "node:assert/strict";
        import { Console } from "node:console";
        import { appendFileSync, readFileSync } from "node:fs";
        const { guardConsolePipe } = await import(${JSON.stringify(pathToFileURL(join(home, "stdio.mjs")).href)});
        const output = process[${JSON.stringify(target)}];
        if (${guarded}) guardConsolePipe(output);
        const console = new Console({ stdout: output, stderr: output, ignoreErrors: false });
        const file = ${JSON.stringify(join(home, `${target}.log`))};
        process.once("message", () => {
          console.warn("synthetic warning to closed launcher");
          setTimeout(() => {
            console.warn("second warning");
            output.write("callback", () => {
              appendFileSync(file, "file logging still works");
              assert.equal(readFileSync(file, "utf8"), "file logging still works");
              process.send("alive", () => process.disconnect());
            });
          }, 20);
        });
        process.send("ready");
      `,
        ],
        { cwd: home, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
      )
      const messages: unknown[] = []
      const errors: string[] = []
      child[target === "stdout" ? "stderr" : "stdout"]?.on("data", (chunk) => errors.push(chunk.toString()))
      child.on("message", (message) => {
        messages.push(message)
        if (message !== "ready") return
        child[target]?.destroy()
        child.send("write")
      })
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      if (!guarded) {
        expect(result).toEqual({ code: 1, signal: null })
        expect(messages).toEqual(["ready"])
        continue
      }
      expect({ result, errors, messages }).toEqual({
        result: { code: 0, signal: null },
        errors: [],
        messages: ["ready", "alive"],
      })
    }
  } finally {
    const actual = await realpath(home)
    if (dirname(actual) !== parent) throw new Error("Console fixture cleanup scope mismatch")
    await rm(actual, { recursive: true, force: true })
  }
}, 15_000)
