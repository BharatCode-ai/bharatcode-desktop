import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each(["beta", "prod", "latest", "local"])(
  "compiled %s policy cannot be weakened by runtime overrides",
  async (channel) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bharatcode-policy-"))
    try {
      const outfile = path.join(root, "policy.mjs")
      // Compile in a fresh process: Bun's in-process module cache can otherwise
      // conflict with modules already evaluated by the surrounding runtime suite.
      const build = await run(
        [
          "build",
          path.join(import.meta.dir, "fixtures/compiled-policy.ts"),
          "--target=bun",
          "--outfile",
          outfile,
          "--define",
          `OPENCODE_CHANNEL=${JSON.stringify(channel)}`,
        ],
        path.resolve(import.meta.dir, "../.."),
      )
      expect({ code: build.code, error: build.error }).toEqual({ code: 0, error: "" })
      for (const env of [
        {},
        { BHARATCODE_CHANNEL: "local" },
        { BHARATCODE_PRODUCT_POLICY: "generic" },
        { BHARATCODE_CHANNEL: "local", BHARATCODE_PRODUCT_POLICY: "generic" },
        { BHARATCODE_PRODUCT_POLICY: "shipped" },
      ]) {
        const result = await run([outfile], root, {
          ...process.env,
          BHARATCODE_CHANNEL: "",
          BHARATCODE_PRODUCT_POLICY: "",
          ...env,
        })
        expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" })
        const shipped = channel !== "local" || env.BHARATCODE_PRODUCT_POLICY === "shipped"
        expect(JSON.parse(result.output)).toEqual({ selected: shipped, shipped, externalProvider: !shipped })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

async function run(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output, error }
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}
