import semver from "semver"
import path from "path"
import { releaseIdentity } from "./release"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const product = await Bun.file(path.resolve(import.meta.dir, "../../opencode/package.json")).json()
const identity = releaseIdentity(product.version, process.env)

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return identity.channel
  },
  get version() {
    return identity.version
  },
  get preview() {
    return identity.preview
  },
  get release(): boolean {
    return process.env.OPENCODE_RELEASE === "1"
  },
  get team() {
    return team
  },
}
console.log(`bharatcode script`, JSON.stringify(Script, null, 2))
