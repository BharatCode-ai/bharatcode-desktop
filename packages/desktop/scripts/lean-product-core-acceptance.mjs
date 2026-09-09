import { access, mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const tmp = resolve(root, ".tmp/lean-product-core-acceptance")

async function run(name, cwd, argv, environment = {}) {
  const child = Bun.spawn(argv, {
    cwd: resolve(root, cwd),
    env: { ...process.env, TMPDIR: tmp, NO_COLOR: "1", ...environment },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { name, cwd, argv, exitCode, stdout, stderr }
}

async function selfCheck() {
  await mkdir(tmp, { recursive: true })
  const packageInstall = await run("package", "packages/opencode", [
    "bun",
    "test",
    "test/distribution/lean-package.test.ts",
  ])
  const home = resolve(tmp, `home-${crypto.randomUUID()}`)
  const project = resolve(tmp, `project-${crypto.randomUUID()}`)
  const vertical = await run(
    "vertical",
    "packages/opencode",
    ["bun", "test/product/fixtures/core-vertical-worker.ts"],
    {
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: resolve(home, "data"),
      XDG_CONFIG_HOME: resolve(home, "config"),
      XDG_CACHE_HOME: resolve(home, "cache"),
      XDG_STATE_HOME: resolve(home, "state"),
      BHARATCODE_CHANNEL: "test",
      BHARATCODE_ACCEPTANCE_PROJECT: project,
    },
  )
  const titlebars = await run("titlebars", "packages/app", ["bun", "test", "src/components/titlebar-account.test.ts"])
  const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()
  let runtime
  try {
    runtime = vertical.exitCode === 0 ? JSON.parse(vertical.stdout) : undefined
  } finally {
    await Promise.all([rm(home, { recursive: true, force: true }), rm(project, { recursive: true, force: true })])
  }
  const cleanup = {
    home: await removed(home),
    project: await removed(project),
  }
  const scenarios = {
    1: packageInstall.exitCode === 0 ? "PASS" : "FAIL",
    2: runtime?.checks.sharedIdentity ? "PASS" : "FAIL",
    3:
      runtime?.checks.streamedTextAndTool &&
      runtime?.checks.editApplied &&
      runtime?.checks.commandRan &&
      runtime?.checks.restartContinuity
        ? "PASS"
        : "FAIL",
    4: runtime?.checks.liveCatalog ? "PASS" : "FAIL",
    5: runtime?.checks.accountLifecycle && titlebars.exitCode === 0 ? "PASS" : "FAIL",
    8: runtime?.checks.boundaryClosed ? "PASS" : "FAIL",
  }
  return {
    source,
    testName: "lean-product-core-scenarios-1-5-8",
    scenarios,
    runtime,
    cleanup,
    observations: [packageInstall, vertical, titlebars].map((item) => ({
      name: item.name,
      cwd: item.cwd,
      argv: item.argv,
      exitCode: item.exitCode,
      passCount: Number(`${item.stdout}\n${item.stderr}`.match(/\b(\d+) pass\b/)?.[1] ?? 0),
      failCount: Number(`${item.stdout}\n${item.stderr}`.match(/\b(\d+) fail\b/)?.[1] ?? 0),
      stderr: item.exitCode === 0 ? "" : item.stderr.slice(-6000),
    })),
    forbiddenAttempts: runtime?.forbiddenAttempts ?? [{ kind: "worker", target: "vertical-runtime-failed" }],
  }
}

async function removed(path) {
  return access(path).then(
    () => false,
    () => true,
  )
}

if (process.argv.includes("--self-check")) {
  selfCheck().then(
    (receipt) => console.log(JSON.stringify(receipt)),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
