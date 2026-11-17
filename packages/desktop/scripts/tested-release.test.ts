import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { stageFixture, identity } from "./fixtures/desktop-cohort"

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
const publisher = path.join(import.meta.dir, "publish-tested-release.sh")

test("publication is a separate approved default-branch action and never rebuilds or clobbers", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.on.workflow_dispatch.inputs.manual_acceptance_confirmed.default).toBe(false)
  expect(workflow.on.workflow_dispatch.inputs.notify_website.default).toBe(false)
  expect(workflow.permissions).toEqual({ contents: "read", actions: "read" })
  expect(workflow.jobs.publish.if).toContain("inputs.manual_acceptance_confirmed")
  expect(workflow.jobs.publish.if).toContain("github.event.repository.default_branch")
  expect(workflow.jobs.publish.environment).toBe("desktop-beta-release")
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
  expect(steps.find((step) => step.name === "Checkout exact tested source")?.with?.ref).toBe("${{ inputs.source_sha }}")
  expect(steps.find((step) => step.name === "Download the exact tested cohort")?.with?.name).toBe(
    "desktop-cohort-${{ inputs.build_run_id }}-${{ inputs.build_run_attempt }}",
  )
  const commands = steps.map((step) => step.run ?? "").join("\n")
  expect(commands).not.toMatch(/--clobber|npm publish|electron-builder|bun install|bun run build/)
  expect(workflow.on.workflow_dispatch.inputs.approve_unsigned_windows.default).toBe(false)
  expect(workflow.jobs.publish.if).toContain("inputs.approve_unsigned_windows")
  expect(steps.find((step) => step.name === "Checkout protected publication tooling")?.with?.ref).toBe(
    "${{ github.sha }}",
  )
  expect(steps.at(-2)?.run).toContain("bash packages/desktop/scripts/publish-tested-release.sh")
  expect(steps.at(-1)?.run).toContain('channel:"stable"')
  expect(steps.at(-1)?.name).toBe("Notify website only after download verification")
})

test("every publication shell step parses before any external action", () => {
  expect(spawnSync("bash", ["-n", publisher]).status).toBe(0)
  for (const step of steps.filter((item) => item.run)) {
    const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" })
    expect({ step: step.name, status: result.status, error: result.stderr }).toEqual({
      step: step.name,
      status: 0,
      error: "",
    })
  }
})

type Remote = {
  refs: Record<string, string>
  events: string[]
  releases: {
    tag_name: string
    target_commitish: string
    body: string
    draft: boolean
    immutable: boolean
    prerelease: boolean
    assets: { name: string; state: string; digest: string; data: string }[]
  }[]
}

test("the actual publisher resumes partial drafts and verified public releases; conflicting state is never adopted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-offline-publish-"))
  try {
    const { release, output } = await stageFixture(root)
    const db = path.join(root, "remote.json")
    const read = async (): Promise<Remote> => Bun.file(db).json()
    const write = (state: Remote) => fs.writeFile(db, JSON.stringify(state))
    const stable = release.tag
    const bridge = release.compatibility!
    for (const cmd of ["gh", "curl"]) {
      await fs.writeFile(path.join(root, cmd), `#!/bin/sh\nexec "$FIXTURE_BUN" "$FIXTURE_COMMAND" ${cmd} "$@"\n`, {
        mode: 0o700,
      })
    }
    const run = (overrides: Record<string, string> = {}) =>
      spawnSync("bash", [publisher, output], {
        encoding: "utf8",
        env: {
          PATH: root + ":" + process.env.PATH,
          FIXTURE_COMMAND: path.join(import.meta.dir, "fixtures/release-transport.mjs"),
          FIXTURE_BUN: process.execPath,
          FIXTURE_DB: db,
          GITHUB_ACTOR: "fixture-operator",
          GITHUB_REPOSITORY: identity.repository,
          SOURCE_SHA: identity.source,
          SOURCE_RUN_ID: identity.run,
          SOURCE_RUN_ATTEMPT: identity.attempt,
          RELEASE_TAG: stable,
          CANDIDATE_SHA256: release.candidateSha256,
          MANUAL_ACCEPTANCE: "true",
          APPROVE_UNSIGNED_WINDOWS: "true",
          ACCEPTANCE_NOTES: "Synthetic QA only.",
          ...overrides,
        },
      })
    await write({ refs: { [stable]: identity.source }, events: [], releases: [] })
    expect(run().status).not.toBe(0)
    expect((await read()).events).toEqual([])
    await write({ refs: {}, events: [], releases: [] })
    for (const gate of ["MANUAL_ACCEPTANCE", "APPROVE_UNSIGNED_WINDOWS"]) {
      expect(run({ [gate]: "false" }).status).not.toBe(0)
      expect((await read()).events).toEqual([])
    }
    expect(run({ FIXTURE_INTERRUPT: "upload:" + stable + "/bharatcode-desktop-linux-amd64.deb" }).status).not.toBe(0)
    const partial = await read()
    expect(partial.events).toEqual(["draft:" + stable, "upload:" + stable + "/SHA256SUMS"])
    expect(partial.releases[0].draft).toBe(true)
    for (const mutate of [
      (r: Remote["releases"][number]) => {
        r.target_commitish = "c".repeat(40)
      },
      (r: Remote["releases"][number]) => {
        r.prerelease = true
      },
      (r: Remote["releases"][number]) => {
        r.body = "unrelated draft"
      },
      (r: Remote["releases"][number]) => {
        r.assets[0].digest = "sha256:" + "0".repeat(64)
      },
      (r: Remote["releases"][number]) => {
        r.assets[0].state = "starter"
      },
      (r: Remote["releases"][number]) => {
        r.assets[0].name = "extra.exe"
      },
    ]) {
      const conflict = structuredClone(partial)
      mutate(conflict.releases[0])
      await write(conflict)
      expect(run().status).not.toBe(0)
      expect(await read()).toEqual(conflict)
    }
    await write(partial)
    expect(run({ FIXTURE_INTERRUPT: "download:" + stable + "/SHA256SUMS" }).status).not.toBe(0)
    const published = await read()
    expect(published.releases.map((r) => [r.tag_name, r.draft, r.prerelease])).toEqual([[stable, false, false]])
    expect(published.events).toContain("publish:" + stable)
    for (const mutate of [
      (s: Remote) => {
        s.refs[stable] = "d".repeat(40)
      },
      (s: Remote) => {
        s.releases[0].immutable = false
      },
      (s: Remote) => {
        s.releases[0].assets.pop()
      },
      (s: Remote) => {
        s.releases[0].assets[0].data = Buffer.from("wrong bytes").toString("base64")
      },
    ]) {
      const conflict = structuredClone(published)
      mutate(conflict)
      await write(conflict)
      expect(run().status).not.toBe(0)
      expect((await read()).releases).toHaveLength(1)
    }
    await write(published)
    expect(run({ FIXTURE_INTERRUPT: "upload:" + bridge + "/beta.yml" }).status).not.toBe(0)
    const staging = await read()
    expect(staging.releases[1].draft).toBe(true)
    expect(staging.events.indexOf("draft:" + bridge)).toBeGreaterThan(
      staging.events.indexOf("download:" + stable + "/release-manifest.json"),
    )
    const success = run()
    expect({ status: success.status, error: success.stderr }).toEqual({ status: 0, error: "" })
    const complete = await read()
    expect(complete.releases[1]).toMatchObject({ tag_name: bridge, prerelease: true, immutable: true, draft: false })
    expect(complete.releases[1].assets.map((a) => a.name)).toEqual(["beta-linux.yml", "beta-mac.yml", "beta.yml"])
    expect(run().status).toBe(0)
    const replay = await read()
    expect(replay.events.slice(complete.events.length).every((entry) => entry.startsWith("download:"))).toBe(true)
    expect(replay.releases).toEqual(complete.releases)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)

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
