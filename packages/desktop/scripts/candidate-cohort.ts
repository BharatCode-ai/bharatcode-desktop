import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

export type Identity = {
  source: string
  tree: string
  version: string
  channel: "beta" | "prod"
  repository: string
  run: string
  attempt: string
}
const targets = ["windows-x64", "darwin-x64", "darwin-arm64", "linux-x64"] as const
type Target = (typeof targets)[number]
type File = { name: string; bytes: number; sha256: string }
export type Receipt = {
  schema: 1
  identity: Identity
  target: Target
  files: File[]
  signing: "unsigned" | "apple-notarized-stapled"
  verification: "package-build-only"
  acceptance: "pending"
}
const fail = () => new Error("Candidate identity, policy or artifact verification failed")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function validateIdentity(
  value: Identity,
  source: {
    head: string
    tree: string
    dirty: boolean
    workflowSource: string
    desktopVersion: string
    cliVersion: string
  },
) {
  if (
    !/^[a-f0-9]{40}$/.test(value.source) ||
    !/^[a-f0-9]{40}$/.test(value.tree) ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !["beta", "prod"].includes(value.channel) ||
    value.repository !== "BharatCode-ai/bharatcode-desktop" ||
    !/^[1-9]\d*$/.test(value.run) ||
    !/^[1-9]\d*$/.test(value.attempt) ||
    source.dirty ||
    value.source !== source.head ||
    value.source !== source.workflowSource ||
    value.tree !== source.tree ||
    value.version !== source.desktopVersion ||
    value.version !== source.cliVersion
  )
    throw fail()
  return value
}

function stem(target: Target) {
  return `bharatcode-desktop-${target.replace("windows", "win").replace("darwin", "mac")}`
}
function required(target: Target) {
  // electron-builder applies target-specific architecture aliases to Linux.
  if (target === "linux-x64") return ["bharatcode-desktop-linux-x86_64.AppImage", "bharatcode-desktop-linux-amd64.deb"]
  const extensions = target.startsWith("darwin") ? ["zip"] : target === "windows-x64" ? ["exe"] : ["AppImage", "deb"]
  return extensions.map((ext) => `${stem(target)}.${ext}`)
}
function updater(target: Target, channel: Identity["channel"]) {
  return `${target}-${channel === "beta" ? "beta" : "latest"}${target.startsWith("darwin") ? "-mac" : target === "linux-x64" ? "-linux" : ""}.yml`
}
async function verifyUpdater(directory: string, name: string, files: File[], identity: Pick<Identity, "version">) {
  const metadata = Bun.YAML.parse((await bytes(path.join(directory, name))).toString()) as {
    version: string
    files: Array<{ url: string; sha512: string; size: number }>
    path?: string
    sha512?: string
  }
  if (metadata.version !== identity.version || !Array.isArray(metadata.files) || !metadata.files.length) throw fail()
  for (const file of metadata.files) {
    if (!files.some((known) => known.name === file.url) || !/^[a-zA-Z0-9._-]+$/.test(file.url)) throw fail()
    const artifact = await bytes(path.join(directory, file.url))
    if (file.size !== artifact.length || file.sha512 !== createHash("sha512").update(artifact).digest("base64"))
      throw fail()
  }
  if (metadata.path !== undefined || metadata.sha512 !== undefined) {
    const primary = metadata.files.find((file) => file.url === metadata.path)
    if (!primary || primary.sha512 !== metadata.sha512) throw fail()
  }
}

export async function inspectPackageOutputs(
  dist: string,
  target: Target,
  identity: Pick<Identity, "version" | "channel">,
) {
  const packages = required(target)
  const entries = await fs.readdir(dist)
  if (packages.some((name) => !entries.includes(name))) throw fail()
  const metadata = updater(target, identity.channel).slice(target.length + 1)
  if (!entries.includes(metadata)) throw fail()
  const names = entries.filter(
    (name) => packages.includes(name) || packages.some((item) => name === `${item}.blockmap`),
  )
  names.push(metadata)
  const files: File[] = []
  for (const name of names.sort()) {
    const content = await bytes(path.join(dist, name))
    files.push({ name, bytes: content.length, sha256: hash(content) })
  }
  await verifyUpdater(dist, metadata, files, identity)
  return files
}
async function bytes(file: string) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) throw fail()
  return fs.readFile(file)
}

export async function assembleCohort(root: string, identity: Identity) {
  const files: Array<File & { producer: Target }> = []
  for (const target of targets) {
    const directory = path.join(root, target)
    if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) throw fail()
    const receipt = JSON.parse((await bytes(path.join(directory, "receipt.json"))).toString()) as Receipt
    if (
      receipt.schema !== 1 ||
      receipt.target !== target ||
      receipt.acceptance !== "pending" ||
      receipt.verification !== "package-build-only" ||
      receipt.signing !== (target.startsWith("darwin") ? "apple-notarized-stapled" : "unsigned") ||
      Object.keys(identity).some(
        (key) => receipt.identity[key as keyof Identity] !== identity[key as keyof Identity],
      ) ||
      !Array.isArray(receipt.files) ||
      new Set(receipt.files.map((x) => x.name)).size !== receipt.files.length ||
      [...required(target), updater(target, identity.channel)].some(
        (name) => !receipt.files.some((file) => file.name === name),
      )
    )
      throw fail()
    for (const file of receipt.files) {
      if (
        !/^[a-zA-Z0-9._-]+$/.test(file.name) ||
        file.name === "receipt.json" ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes <= 0
      )
        throw fail()
      const content = await bytes(path.join(directory, file.name))
      if (content.length !== file.bytes || hash(content) !== file.sha256) throw fail()
      if (files.some((existing) => existing.name === file.name)) throw fail()
      files.push({ ...file, producer: target })
    }
    await verifyUpdater(directory, updater(target, identity.channel), receipt.files, identity)
  }
  return { schema: 1, identity, files, acceptance: "pending", publication: "not-authorized" }
}

export async function collectCohort(root: string, identity: Identity) {
  const names = targets.map((target) => `candidate-${target}-${identity.run}-${identity.attempt}`)
  const entries = await fs.readdir(root)
  if (entries.length !== names.length || entries.some((name) => !names.includes(name))) throw fail()
  for (const name of names) {
    const stat = await fs.lstat(path.join(root, name))
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail()
  }
  const output = path.join(root, "cohort")
  await fs.mkdir(output)
  for (const [index, target] of targets.entries()) {
    await fs.rename(path.join(root, names[index]), path.join(output, target))
  }
  return output
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim()
async function currentIdentity(): Promise<Identity> {
  const desktop = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"))
  const cli = JSON.parse(await fs.readFile(new URL("../../opencode/package.json", import.meta.url), "utf8"))
  const value = {
    source: process.env.BHARATCODE_SOURCE_SHA ?? "",
    tree: git("rev-parse", "HEAD^{tree}"),
    version: desktop.version,
    channel: process.env.BHARATCODE_CHANNEL as Identity["channel"],
    repository: process.env.GITHUB_REPOSITORY ?? "",
    run: process.env.GITHUB_RUN_ID ?? "",
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  }
  return validateIdentity(value, {
    head: git("rev-parse", "HEAD"),
    tree: value.tree,
    dirty: !!git("status", "--porcelain", "--untracked-files=normal"),
    workflowSource: process.env.GITHUB_SHA ?? "",
    desktopVersion: desktop.version,
    cliVersion: cli.version,
  })
}

async function verifySigning(target: Target, dist: string, identity: Identity) {
  if (target === "windows-x64") {
    const files = [path.join(dist, `${stem(target)}.exe`), path.join(dist, "win-unpacked/resources/bharatcode-cli.exe")]
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`
      $ErrorActionPreference = 'Stop'
      foreach ($file in (ConvertFrom-Json ([Console]::In.ReadToEnd()))) {
        $sig = Get-AuthenticodeSignature -LiteralPath $file
        if ($sig.Status -ne 'NotSigned' -or $sig.SignerCertificate -or $sig.TimeStamperCertificate) { exit 1 }
      }
      [Console]::Out.Write('unsigned')
    `,
      ],
      { input: JSON.stringify(files), encoding: "utf8", timeout: 30_000 },
    )
    if (output !== "unsigned") throw fail()
    return "unsigned" as const
  }
  if (!target.startsWith("darwin")) return "unsigned" as const
  // Check the archive that will be handed off, not merely the unpacked builder directory.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bc-candidate-signature-"))
  try {
    execFileSync("ditto", ["-x", "-k", path.join(dist, `${stem(target)}.zip`), temporary], { stdio: "pipe" })
    const apps = (await fs.readdir(temporary)).filter((name) => name.endsWith(".app"))
    if (apps.length !== 1) throw fail()
    const app = path.join(temporary, apps[0])
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })
    // Require the Developer ID certificate class; this is not a team-ownership attestation.
    execFileSync(
      "codesign",
      ["--verify", "-R=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", app],
      { stdio: "pipe" },
    )
    execFileSync("xcrun", ["stapler", "validate", app], { stdio: "pipe" })
    const version = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")],
      { encoding: "utf8" },
    ).trim()
    if (version !== identity.version) throw fail()
    return "apple-notarized-stapled" as const
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function record(root: string, target: Target, identity: Identity) {
  if (
    !targets.includes(target) ||
    `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` !== target
  )
    throw fail()
  const desktop = path.resolve(import.meta.dir, "..")
  const dist = path.join(desktop, "dist")
  const signing = await verifySigning(target, dist, identity)
  const artifacts = await inspectPackageOutputs(dist, target, identity)
  const directory = path.join(root, target)
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(directory)
  const files: File[] = []
  // Keep each platform's raw updater metadata distinct. Final promotion must
  // merge and validate it against this complete cohort; builds never upload it.
  for (const file of artifacts) {
    const name = file.name.endsWith(".yml") ? `${target}-${file.name}` : file.name
    await fs.copyFile(path.join(dist, file.name), path.join(directory, name), constants.COPYFILE_EXCL)
    const content = await bytes(path.join(directory, name))
    if (content.length !== file.bytes || hash(content) !== file.sha256) throw fail()
    files.push({ ...file, name })
  }
  if (!files.some((file) => file.name === updater(target, identity.channel))) throw fail()
  await verifyUpdater(directory, updater(target, identity.channel), files, identity)
  const receipt: Receipt = {
    schema: 1,
    identity,
    target,
    files,
    signing,
    verification: "package-build-only",
    acceptance: "pending",
  }
  await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
}

if (import.meta.main) {
  const identity = await currentIdentity()
  const [mode, directory, target] = process.argv.slice(2)
  if (mode === "admit") {
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${identity.version}\n`)
    console.log(JSON.stringify(identity))
  } else if (mode === "record" && directory && target) {
    await record(path.resolve(directory), target as Target, identity)
  } else if (mode === "collect" && directory) {
    await collectCohort(path.resolve(directory), identity)
  } else if (mode === "assemble" && directory) {
    const cohort = await assembleCohort(path.resolve(directory), identity)
    await fs.writeFile(path.join(directory, "cohort.json"), JSON.stringify(cohort, null, 2) + "\n", { flag: "wx" })
  } else throw fail()
}
