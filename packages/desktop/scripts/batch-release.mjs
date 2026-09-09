// Small release utility: stage the existing build outputs, or verify the same
// files before publication. Manual acceptance is recorded by the operator.
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { PLATFORM_PACKAGE_NAMES } from "../../opencode/script/lean-cohort.mjs"

const repository = "BharatCode-ai/bharatcode-desktop"
const workflow = ".github/workflows/bharatcode-next-beta-candidate.yml"
const root = "release-assets"
const source = process.env.SOURCE_SHA
const run = process.env.SOURCE_RUN_ID ?? process.env.GITHUB_RUN_ID
const version = (await Bun.file("packages/desktop/package.json").json()).version
if (!/^[0-9a-f]{40}$/.test(source ?? "") || !/^[1-9][0-9]*$/.test(run ?? "")) throw new Error("Invalid source/run")
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid version")
if ((await Bun.file("packages/opencode/package.json").json()).version !== version) throw new Error("Version mismatch")

const desktop = {
  "bharatcode-desktop-next-beta-win-x64.exe": "unsigned",
  "bharatcode-desktop-next-beta-mac-arm64.zip": "apple-notarized-stapled",
  "bharatcode-desktop-next-beta-mac-x64.zip": "apple-notarized-stapled",
  "bharatcode-desktop-next-beta-linux-x64.AppImage": "unsigned",
  "bharatcode-desktop-next-beta-linux-x64.deb": "unsigned",
}
const packages = ["bharatcode", ...PLATFORM_PACKAGE_NAMES].map((name) => `${name}-${version}.tgz`)
const signedSubjects = [...Object.keys(desktop), ...packages].sort()
const assets = [
  ...signedSubjects,
  ...signedSubjects.map((name) => `${name}.intoto.jsonl`),
  "beta.yml",
  "beta-mac.yml",
  "beta-linux.yml",
  ...Object.keys(desktop)
    .filter((name) => /\.(exe|zip)$/.test(name))
    .map((name) => `${name}.blockmap`),
].sort()

async function hash(file) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Invalid artifact: ${basename(file)}`)
  return {
    bytes: stat.size,
    sha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
      .digest("hex"),
  }
}

if (process.argv[2] === "stage") {
  const expected = ["cp2-cli", "cp2-windows", "cp2-macos-arm64", "cp2-macos-x64", "cp2-linux"]
    .map((name) => `${name}-${run}`)
    .sort()
  if (JSON.stringify((await readdir("cohort-input")).sort()) !== JSON.stringify(expected))
    throw new Error("Incomplete producer set")
  const paths = [
    ...(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: "cohort-input", absolute: true, onlyFiles: true }))),
    ...(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: "updater-assets", absolute: true, onlyFiles: true }))),
  ]
  const one = (name) => {
    const matches = paths.filter((file) => basename(file) === name)
    if (matches.length !== 1) throw new Error(`Expected exactly one ${name}`)
    return matches[0]
  }
  // Standard GitHub provenance, not a custom acceptance/waiver receipt system.
  for (const name of signedSubjects) {
    const result = Bun.spawnSync(
      [
        "gh",
        "attestation",
        "verify",
        one(name),
        "--bundle",
        one(`${name}.intoto.jsonl`),
        "--repo",
        repository,
        "--signer-workflow",
        `${repository}/${workflow}`,
        "--source-digest",
        source,
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
      ],
      { stdout: "ignore", stderr: "inherit" },
    )
    if (result.exitCode !== 0) throw new Error(`Provenance verification failed: ${name}`)
  }
  const runtime = await Bun.file(one("bharatcode-wsl-runtime-manifest.json")).json()
  if (runtime.source_sha !== source || runtime.version !== version)
    throw new Error("Bundled WSL runtime identity mismatch")
  const runtimeHash = await hash(one("bharatcode-runtime-linux-x64-glibc"))
  if (runtime.sha256 !== runtimeHash.sha256 || runtime.bytes !== runtimeHash.bytes)
    throw new Error("WSL runtime digest mismatch")
  await mkdir(root)
  const files = []
  for (const name of assets) {
    const input = one(name)
    const digest = await hash(input)
    await copyFile(input, join(root, name))
    files.push({ name, ...digest })
  }
  const manifest = {
    version,
    tag: `desktop-beta-${version}`,
    repository,
    source_sha: source,
    workflow,
    build_run_id: run,
    assembly_attempt: process.env.GITHUB_RUN_ATTEMPT,
    signing: desktop,
    manual_acceptance: "pending",
    wsl_runtime: runtime,
    files,
  }
  await Bun.write(join(root, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  const manifestHash = await hash(join(root, "release-manifest.json"))
  await Bun.write(
    join(root, "SHA256SUMS"),
    [...files, { name: "release-manifest.json", ...manifestHash }]
      .map((file) => `${file.sha256}  ${file.name}\n`)
      .join(""),
  )
  console.log(`Staged ${files.length} files for ${manifest.tag}; manual acceptance is still pending.`)
} else if (process.argv[2] === "verify") {
  const manifest = await Bun.file(join(root, "release-manifest.json")).json()
  if (
    manifest.repository !== repository ||
    manifest.workflow !== workflow ||
    manifest.source_sha !== source ||
    manifest.build_run_id !== run ||
    manifest.version !== version ||
    manifest.tag !== `desktop-beta-${version}` ||
    manifest.manual_acceptance !== "pending" ||
    JSON.stringify(manifest.signing) !== JSON.stringify(desktop)
  ) {
    throw new Error("Candidate identity/signing policy mismatch")
  }
  if (JSON.stringify(manifest.files.map((file) => file.name)) !== JSON.stringify(assets))
    throw new Error("Artifact set mismatch")
  if (
    JSON.stringify((await readdir(root)).sort()) !==
    JSON.stringify([...assets, "release-manifest.json", "SHA256SUMS"].sort())
  ) {
    throw new Error("Candidate contains missing or unexpected files")
  }
  for (const file of manifest.files) {
    const actual = await hash(join(root, file.name))
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`Artifact changed: ${file.name}`)
  }
  console.log(`Verified exact ${manifest.tag} artifacts from ${source}, run ${run}.`)
} else if (process.argv[2] === "check-release") {
  const state = await Bun.file("release-state.json").json()
  const draft = process.argv[3] === "draft"
  if (
    !["draft", "published"].includes(process.argv[3]) ||
    state.draft !== draft ||
    !state.prerelease ||
    state.tag_name !== `desktop-beta-${version}` ||
    state.target_commitish !== source ||
    (!draft && state.immutable !== true)
  ) {
    throw new Error("Release state/source mismatch")
  }
  const names = (await readdir(root)).sort()
  if (JSON.stringify(state.assets.map((asset) => asset.name).sort()) !== JSON.stringify(names))
    throw new Error("Release file set mismatch")
  for (const asset of state.assets) {
    const actual = await hash(join(root, asset.name))
    if (
      asset.size !== actual.bytes ||
      asset.digest !== `sha256:${actual.sha256}` ||
      asset.browser_download_url !==
        `https://github.com/${repository}/releases/download/${state.tag_name}/${asset.name}`
    ) {
      throw new Error(`Published file mismatch: ${asset.name}`)
    }
  }
  console.log(`Verified ${draft ? "draft" : "published"} release files.`)
} else {
  throw new Error("Use stage, verify, or check-release")
}
