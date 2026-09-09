#!/usr/bin/env node

import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { DISTRIBUTION, hostDistributionTarget } from "./distribution.mjs"

const directory = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const target = hostDistributionTarget()
const cached = path.join(directory, "bin", `.${DISTRIBUTION.commandName}`)

function copy(source) {
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  fs.copyFileSync(source, cached)
  fs.chmodSync(cached, 0o755)
  return childProcess.spawnSync(cached, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0
}

for (const name of target.candidates) {
  try {
    const manifest = require.resolve(`${name}/package.json`)
    if (copy(path.join(path.dirname(manifest), "bin", target.binary))) process.exit(0)
  } catch {
    // Optional dependencies for other platforms are expected to be absent.
  }
}

console.error(`No working BharatCode CLI artifact is installed for this platform (${target.candidates.join(", ")}).`)
process.exit(1)
