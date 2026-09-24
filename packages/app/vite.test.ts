import { expect, test } from "bun:test"

test("renderer respects BharatCode beta channel instead of upstream dev fallback", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const {default: plugins}=await import('./vite.js'); console.log(plugins[0].config().define['import.meta.env.VITE_OPENCODE_CHANNEL'])`,
    ],
    {
      cwd: import.meta.dir,
      env: { ...process.env, BHARATCODE_CHANNEL: "beta", OPENCODE_CHANNEL: "dev" },
    },
  )
  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout).trim()).toBe('"beta"')
})
