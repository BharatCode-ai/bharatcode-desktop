import { Database } from "bun:sqlite"

import { captureMigrationSource, type MigrationDestination } from "@/migration/capture"
import type { MigrationSource } from "@/migration/source"

type Input = {
  source: MigrationSource
  destination: MigrationDestination
  crash?: "pre-sanitize" | "post-sanitize"
}

const input = JSON.parse(process.argv[2] ?? "") as Input
const originalRun = Database.prototype.run
const originalSerialize = Database.prototype.serialize
let serializations = 0

Database.prototype.run = function (...args: Parameters<Database["run"]>) {
  const result = originalRun.apply(this, args)
  const sql = String(args[0]).trim().toUpperCase()
  if (input.crash === "pre-sanitize" && sql.startsWith("VACUUM INTO ")) process.kill(process.pid, "SIGKILL")
  if (input.crash === "post-sanitize" && sql === "VACUUM") process.kill(process.pid, "SIGKILL")
  return result
}

Database.prototype.serialize = function (...args: Parameters<Database["serialize"]>) {
  const result = originalSerialize.apply(this, args)
  serializations += 1
  if (input.crash === "pre-sanitize" && serializations === 1) process.kill(process.pid, "SIGKILL")
  if (input.crash === "post-sanitize" && serializations === 2) process.kill(process.pid, "SIGKILL")
  return result
}

const captured = await captureMigrationSource(input.source, input.destination)
process.stdout.write(JSON.stringify(captured))
