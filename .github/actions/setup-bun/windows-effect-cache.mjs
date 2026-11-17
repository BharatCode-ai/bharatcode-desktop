// Many workspaces depend on this patched Effect release. On a cold NTFS
// cache Bun 1.4.2 can race itself publishing several copies of the same patch.
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = process.cwd()
const spec = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).patchedDependencies).find((entry) =>
  entry.startsWith("effect@"),
)
if (!spec) throw new Error("Expected a pinned Effect patch")
const version = spec.slice("effect@".length)
const patch = JSON.parse(readFileSync("package.json", "utf8")).patchedDependencies[spec]

function verify(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  if (manifest.name !== "effect" || manifest.version !== version) throw new Error("Unexpected installed Effect version")
  const entries = [
    ...readFileSync(patch, "utf8").matchAll(
      /^index [0-9a-f]+\.\.([0-9a-f]{40})[^\n]*\n--- [^\n]+\n\+\+\+ b\/([^\r\n]+)/gm,
    ),
  ]
  if (!entries.length) throw new Error("No Effect patch output hashes found")
  for (const [, hash, file] of entries) {
    const data = readFileSync(join(directory, file))
    const actual = createHash("sha1")
      .update("blob " + data.length + "\0")
      .update(data)
      .digest("hex")
    if (actual !== hash) throw new Error("Incorrect Effect patch output: " + file)
  }
}

function integrity(lockfile) {
  const packages = Object.values(Bun.JSONC.parse(readFileSync(lockfile, "utf8")).packages)
  const values = new Set(packages.filter((entry) => entry[0] === spec).map((entry) => entry.at(-1)))
  if (values.size !== 1 || !/^sha512-/.test([...values][0]))
    throw new Error("Missing or ambiguous locked Effect integrity")
  return [...values][0]
}

if (process.argv[2] === "prepare") {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "bc-effect-"))
  mkdirSync(dirname(join(dir, patch)), { recursive: true })
  copyFileSync(patch, join(dir, patch))
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { effect: version },
      patchedDependencies: { [spec]: patch },
    }),
  )
  // Only seed the installer's cache. The release workspace still installs
  // from its own frozen lock and never imports code from this scratch folder.
  const result = Bun.spawnSync([process.execPath, "install", "--ignore-scripts", "--linker", "hoisted"], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (!result.success) throw new Error("Effect cache preparation failed")
  if (integrity(join(dir, "bun.lock")) !== integrity("bun.lock")) throw new Error("Effect tarball integrity mismatch")
  verify(join(dir, "node_modules/effect"))
} else if (process.argv[2] === "verify") {
  const cli = createRequire(resolve(root, "packages/opencode/package.json"))
  verify(dirname(cli.resolve("effect/package.json")))
  const platform = createRequire(cli.resolve("@effect/platform-node/package.json"))
  verify(dirname(platform.resolve("effect/package.json")))
  platform.resolve("effect/unstable/http/Cookies")
} else throw new Error("Expected prepare or verify")
