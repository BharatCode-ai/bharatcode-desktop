import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { stageRelease, validateIdentity, type Identity } from "./candidate-cohort"

// Called only after the workflow verifies the successful original producer run.
// No dependencies, rebuild, credentials, network calls or publication occur here.
if (import.meta.main) {
  const [input, output, checkout = process.cwd()] = process.argv.slice(2)
  if (!input || !output) throw new Error("Expected candidate and release directories")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim()
  // Read the tested versions as data. Never run Bun in the candidate tree
  // (its bunfig, preloads and .env are not publication tooling).
  const desktop = JSON.parse(git("show", "HEAD:packages/desktop/package.json"))
  const cli = JSON.parse(git("show", "HEAD:packages/opencode/package.json"))
  const identity = validateIdentity(
    {
      source: process.env.SOURCE_SHA ?? "",
      tree: git("rev-parse", "HEAD^{tree}"),
      version: desktop.version,
      channel: "prod",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      run: process.env.SOURCE_RUN_ID ?? "",
      attempt: process.env.SOURCE_RUN_ATTEMPT ?? "",
    } satisfies Identity,
    {
      head: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      dirty: !!git("status", "--porcelain", "--untracked-files=normal"),
      workflowSource: process.env.SOURCE_SHA ?? "",
      desktopVersion: desktop.version,
      cliVersion: cli.version,
    },
  )
  const release = await stageRelease(
    path.resolve(input),
    path.resolve(output),
    identity,
    process.env.CANDIDATE_SHA256 ?? "",
  )
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `tag=${release.tag}\n`)
  console.log(
    JSON.stringify({
      tag: release.tag,
      source: identity.source,
      files: release.files.length,
      publication: release.publication,
    }),
  )
}
