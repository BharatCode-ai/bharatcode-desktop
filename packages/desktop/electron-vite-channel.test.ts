import { expect, test } from "bun:test"

test("compiled stable titlebar sees prod, not the historical profile or fallback channel", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import { build } from "vite"
    import path from "node:path"
    import config from "./electron.vite.config.ts"
    const entry = path.resolve("../app/src/components/titlebar.tsx")
    const outputs = await build({
      configFile: false, logLevel: "error", plugins: config.renderer.plugins, define: config.renderer.define,
      build: { write: false, minify: false, lib: { entry, formats: ["es"] },
        rollupOptions: { external: id => id !== entry }, target: "esnext" },
    })
    console.log(outputs[0].output.find(item => item.type === "chunk").code)
  `,
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        BHARATCODE_SOURCE_SHA: "unavailable",
        BHARATCODE_CHANNEL: "prod",
        OPENCODE_CHANNEL: "dev",
      },
    },
  )
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toMatch(/function ChannelIndicator\([^)]*\)\s*\{\s*const channel = "prod"/)
}, 30_000)
