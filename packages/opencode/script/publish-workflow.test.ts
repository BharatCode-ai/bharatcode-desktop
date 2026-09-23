import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { PLATFORM_TARGETS, platformPackageName } from "./distribution.mjs"

type Step = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, string> }
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/build-and-publish.yml", import.meta.url)).text(),
) as {
  on: { workflow_dispatch: { inputs: Record<string, { default?: string | boolean }> } }
  jobs: {
    build: { if: string; "runs-on": string; steps: Step[] }
    publish: { if: string; permissions: Record<string, string>; steps: Step[] }
  }
}
const steps = workflow.jobs.publish.steps
const script = (name: string) => steps.find((step) => step.name === name)!.run!

test("CLI builds once and publication requires explicit approval at the same workflow/source SHA", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  const inputs = workflow.on.workflow_dispatch.inputs
  expect(inputs.operation.default).toBe("build")
  for (const name of ["manual_acceptance_confirmed", "publish_npm", "publish_github"])
    expect(inputs[name].default).toBe(false)
  expect(workflow.jobs.build["runs-on"]).toBe("ubuntu-24.04")
  expect(workflow.jobs.build.if).toContain("inputs.operation != 'publish-tested'")
  expect(workflow.jobs.build.steps.find((step) => step.name === "Cross-compile all CLI platforms")?.run).toBe(
    "bun run build",
  )
  for (const guard of [
    "inputs.manual_acceptance_confirmed",
    "inputs.source_sha == github.sha",
    "github.event.repository.default_branch",
  ])
    expect(workflow.jobs.publish.if).toContain(guard)
  expect(workflow.jobs.publish.permissions["id-token"]).toBe("write")
  const commands = steps.map((step) => step.run ?? "").join("\n")
  expect(commands).not.toMatch(/NPM_TOKEN|--clobber|bun run build|bun install/)
  expect(commands).toContain("--provenance --ignore-scripts")
  expect(steps.find((step) => step.uses?.startsWith("actions/download-artifact"))?.with?.name).toBe(
    "cli-candidate-${{ inputs.build_run_id }}-${{ inputs.build_run_attempt }}",
  )
  expect(steps.findIndex((step) => step.name === "Refuse an existing release before any npm writes")).toBeLessThan(
    steps.findIndex((step) => step.name === "Publish platforms then wrapper and verify registry bytes"),
  )
  for (const step of steps.filter((item) => item.run)) {
    expect(spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" }).status).toBe(0)
  }
})

test("actual publication shell keeps the wrapper last, verifies registry bytes, and stops on any failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-npm-publication-"))
  try {
    const version = "1.15.35"
    const packages = [...PLATFORM_TARGETS.map(platformPackageName), "bharatcode"].map((name) => ({
      name,
      file: `${name}-${version}.tgz`,
      integrity: `sha512-${name}`,
    }))
    await fs.writeFile(path.join(root, "verified-cli.json"), JSON.stringify({ version, packages }))
    await fs.writeFile(
      path.join(root, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const root = process.env.RUNNER_TEMP
const data = JSON.parse(fs.readFileSync(path.join(root, "verified-cli.json")))
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\\n")
if (args[0] === "publish") {
  if (path.basename(args[1]) === process.env.FAIL_FILE) process.exit(1)
  process.exit(0)
}
if (args[0] !== "view") process.exit(90)
if (args[2] === "version") {
  if (process.env.REGISTRY_RESULT === "existing") { console.log(JSON.stringify(data.version)); process.exit(0) }
  console.log(JSON.stringify({error:{code:process.env.REGISTRY_RESULT || "E404"}})); process.exit(1)
}
if (args[2] === "dist.integrity") {
  const item = data.packages.find(x => args[1] === x.name + "@" + data.version)
  console.log(JSON.stringify(process.env.WRONG_INTEGRITY ? "wrong" : item.integrity)); process.exit(0)
}
if (args[2] === "dist-tags") { console.log(JSON.stringify({next:data.version})); process.exit(0) }
process.exit(91)
`,
      { mode: 0o700 },
    )
    const execute = (name: string, extra: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", ["-c", script(name)], {
        encoding: "utf8",
        env: { PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, VERSION: version, NPM_TAG: "next", ...extra },
      })
    const calls = async () =>
      (await fs.readFile(path.join(root, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    const preflight = "Refuse existing npm versions before any publication"
    const publish = "Publish platforms then wrapper and verify registry bytes"
    expect(execute(preflight).status).toBe(0)
    expect((await calls()).length).toBe(13)
    expect((await calls()).every((args) => args[0] === "view")).toBe(true)
    expect(execute(publish).status).toBe(0)
    expect((await calls()).filter((args) => args[0] === "publish").map((args) => path.basename(args[1]))).toEqual(
      packages.map((item) => item.file),
    )
    for (const result of ["existing", "E401", "E503"])
      expect(execute(preflight, { REGISTRY_RESULT: result }).status).not.toBe(0)
    await fs.writeFile(path.join(root, "calls.jsonl"), "")
    expect(execute(publish, { FAIL_FILE: packages[2].file }).status).not.toBe(0)
    expect((await calls()).filter((args) => args[0] === "publish")).toHaveLength(3)
    await fs.writeFile(path.join(root, "calls.jsonl"), "")
    expect(execute(publish, { WRONG_INTEGRITY: "1" }).status).not.toBe(0)
    expect((await calls()).filter((args) => args[0] === "publish")).toHaveLength(1)
    for (const invalid of ["not-json", JSON.stringify({ packages: [] })]) {
      await fs.writeFile(path.join(root, "verified-cli.json"), invalid)
      await fs.writeFile(path.join(root, "calls.jsonl"), "")
      expect(execute(preflight).status).not.toBe(0)
      expect(execute(publish).status).not.toBe(0)
      expect(await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).toBe("")
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
