#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { createMetaPackageManifest } from "./pack"
import { createPlatformPackageManifest, DISTRIBUTION, PLATFORM_TARGETS, platformPackageName } from "./distribution.mjs"
import { validateIdentity, type Identity } from "../../desktop/scripts/candidate-cohort"

const fail = () => new Error("CLI candidate identity or artifact verification failed")
const hash = (content: Uint8Array) => createHash("sha256").update(content).digest("hex")
type Packed = { name: string; file: string; size: number; sha256: string }

async function bytes(file: string) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size) throw fail()
  return fs.readFile(file)
}

export async function verifyCandidate(root: string, identity: Identity, manifestSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw fail()
  const manifest = await bytes(path.join(root, "manifest.json"))
  if (hash(manifest) !== manifestSha256) throw fail()
  const receipt = JSON.parse(manifest.toString()) as { version: string; packages: Packed[] }
  if (!isDeepStrictEqual(JSON.parse((await bytes(path.join(root, "source.json"))).toString()), identity)) throw fail()
  const names = [...PLATFORM_TARGETS.map(platformPackageName), DISTRIBUTION.npmPackage]
  if (
    receipt.version !== identity.version ||
    !Array.isArray(receipt.packages) ||
    receipt.packages.length !== names.length ||
    new Set(receipt.packages.map((item) => item.name)).size !== names.length
  )
    throw fail()
  const allowed = [...names.map((name) => `${name}-${identity.version}.tgz`), "manifest.json", "source.json"]
  const entries = await fs.readdir(root)
  if (entries.length !== allowed.length || entries.some((name) => !allowed.includes(name))) throw fail()
  const packages: Array<Packed & { integrity: string }> = []
  for (const name of names) {
    const item = receipt.packages.find((entry) => entry.name === name)
    if (!item || item.file !== `${name}-${identity.version}.tgz` || !/^[a-f0-9]{64}$/.test(item.sha256)) throw fail()
    const file = path.join(root, item.file)
    const content = await bytes(file)
    if (content.length !== item.size || hash(content) !== item.sha256) throw fail()
    // Read only package.json; do not extract, install, or execute candidate code.
    const metadata = JSON.parse(
      execFileSync("tar", ["-xOf", file, "package/package.json"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 60_000,
      }),
    )
    const target = PLATFORM_TARGETS.find((value) => platformPackageName(value) === name)
    const expected = target
      ? createPlatformPackageManifest(target, identity.version)
      : createMetaPackageManifest(identity.version)
    if (!isDeepStrictEqual(metadata, expected)) throw fail()
    packages.push({ ...item, integrity: `sha512-${createHash("sha512").update(content).digest("base64")}` })
  }
  return { version: identity.version, packages }
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2)
  if (!directory) throw fail()
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim()
  const cli = await Bun.file(new URL("../package.json", import.meta.url)).json()
  const desktop = await Bun.file(new URL("../../desktop/package.json", import.meta.url)).json()
  const identity = validateIdentity(
    {
      source: process.env.BHARATCODE_SOURCE_SHA ?? "",
      tree: git("rev-parse", "HEAD^{tree}"),
      version: cli.version,
      channel: process.env.BHARATCODE_CHANNEL as Identity["channel"],
      repository: process.env.GITHUB_REPOSITORY ?? "",
      run: process.env.SOURCE_RUN_ID ?? "",
      attempt: process.env.SOURCE_RUN_ATTEMPT ?? "",
    },
    {
      head: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      dirty: !!git("status", "--porcelain", "--untracked-files=normal"),
      workflowSource: process.env.BHARATCODE_SOURCE_SHA ?? "",
      desktopVersion: desktop.version,
      cliVersion: cli.version,
    },
  )
  const result = await verifyCandidate(path.resolve(directory), identity, process.env.CANDIDATE_SHA256 ?? "")
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${identity.version}\ntag=v${identity.version}\nnpm_tag=${identity.channel === "beta" ? "next" : "latest"}\n`,
    )
  console.log(JSON.stringify(result))
}
