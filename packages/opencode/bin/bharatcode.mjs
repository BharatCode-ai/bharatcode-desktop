#!/usr/bin/env node

import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DISTRIBUTION, hostDistributionTarget } from "../script/distribution.mjs"

const directory = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))
const target = hostDistributionTarget()
const override = process.env[DISTRIBUTION.binaryPathEnvironmentVariable]
const cached = path.join(directory, `.${DISTRIBUTION.commandName}`)

function findBinary() {
  let current = directory
  for (;;) {
    for (const name of target.candidates) {
      const candidate = path.join(current, "node_modules", name, "bin", target.binary)
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

const resolved = override || (fs.existsSync(cached) ? cached : findBinary())
if (!resolved) {
  console.error(`No BharatCode CLI artifact is installed for this platform (${target.candidates.join(", ")}).`)
  process.exit(1)
}

const child = childProcess.spawn(resolved, process.argv.slice(2), { stdio: "inherit", windowsHide: true })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal))
}
child.on("error", (error) => {
  console.error(error.message)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) return process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
