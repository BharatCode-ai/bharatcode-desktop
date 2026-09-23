import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"

type Step = { name: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/bharatcode-publish-tested-candidate.yml", import.meta.url)).text(),
) as {
  on: { workflow_dispatch: { inputs: Record<string, { default?: boolean }> } }
  permissions: Record<string, string>
  concurrency: { "cancel-in-progress": boolean }
  jobs: { publish: { if: string; environment: string; steps: Step[] } }
}
const steps = workflow.jobs.publish.steps

test("publication is a separate approved default-branch action and never rebuilds or clobbers", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.on.workflow_dispatch.inputs.manual_acceptance_confirmed.default).toBe(false)
  expect(workflow.on.workflow_dispatch.inputs.notify_website.default).toBe(false)
  expect(workflow.permissions).toEqual({ contents: "read", actions: "read" })
  expect(workflow.jobs.publish.if).toContain("inputs.manual_acceptance_confirmed")
  expect(workflow.jobs.publish.if).toContain("github.event.repository.default_branch")
  expect(workflow.jobs.publish.environment).toBe("desktop-beta-release")
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
  expect(steps.find((step) => step.name === "Checkout exact candidate tooling")?.with?.ref).toBe(
    "${{ inputs.source_sha }}",
  )
  expect(steps.find((step) => step.name === "Download the exact tested cohort")?.with?.name).toBe(
    "desktop-cohort-${{ inputs.build_run_id }}-${{ inputs.build_run_attempt }}",
  )
  const commands = steps.map((step) => step.run ?? "").join("\n")
  expect(commands).not.toMatch(/--clobber|npm publish|electron-builder|bun install|bun run build/)
  const publish = steps.find((step) => step.name === "Verify uploaded digests before publication")!.run!
  expect(publish.indexOf('diff "$RUNNER_TEMP/expected-digests.txt" "$RUNNER_TEMP/uploaded-digests.txt"')).toBeLessThan(
    publish.indexOf("-F draft=false"),
  )
  expect(publish).toContain(".immutable == true")
  expect(publish).toContain("gh release download")
  expect(steps.at(-1)?.name).toBe("Notify website only after download verification")
})

test("every publication shell step parses before any external action", () => {
  for (const step of steps.filter((item) => item.run)) {
    const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" })
    expect({ step: step.name, status: result.status, error: result.stderr }).toEqual({
      step: step.name,
      status: 0,
      error: "",
    })
  }
})

test("actual preflight rejects stale attempts, wrong workflows, incomplete runs and absent approval notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-publish-preflight-"))
  try {
    // This local command can only return fixture JSON. It cannot contact GitHub
    // or perform publication, even if the workflow's preflight regresses.
    await fs.writeFile(path.join(root, "gh"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_RUN"\n', { mode: 0o700 })
    const source = "a".repeat(40)
    const run = {
      id: 123,
      run_attempt: 2,
      head_sha: source,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      repository: { full_name: "BharatCode-ai/bharatcode-desktop" },
      path: ".github/workflows/publish.yml",
    }
    const execute = (value: unknown, env: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", ["-c", steps[0].run!], {
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "BharatCode-ai/bharatcode-desktop",
          SOURCE_SHA: source,
          SOURCE_RUN_ID: "123",
          SOURCE_RUN_ATTEMPT: "2",
          CANDIDATE_SHA256: "b".repeat(64),
          ACCEPTANCE_NOTES: "Fixture tester: synthetic-only acceptance",
          FIXTURE_RUN: JSON.stringify(value),
          ...env,
        },
      }).status
    expect(execute(run)).toBe(0)
    for (const change of [
      { id: 124 },
      { run_attempt: 1 },
      { head_sha: "c".repeat(40) },
      { event: "pull_request" },
      { status: "in_progress" },
      { conclusion: "failure" },
      { repository: { full_name: "anomalyco/opencode" } },
      { path: ".github/workflows/test.yml" },
    ])
      expect(execute({ ...run, ...change })).not.toBe(0)
    for (const change of [
      { ACCEPTANCE_NOTES: "  \n" },
      { SOURCE_RUN_ID: "../runs" },
      { SOURCE_RUN_ATTEMPT: "0" },
      { SOURCE_SHA: "dev" },
      { CANDIDATE_SHA256: "missing" },
    ])
      expect(execute(run, change)).not.toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
