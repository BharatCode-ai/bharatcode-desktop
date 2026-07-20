import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"

import { captureMigrationSource, type MigrationDestination } from "@/migration/capture"
import type { MigrationSource } from "@/migration/source"

type Input = {
  source: MigrationSource
  destination: MigrationDestination
  crash?: "pre-sanitize" | "post-sanitize"
  observeSerialize?: string
  observeBase64?: string
  reportFailure?: boolean
}

const input = JSON.parse(process.argv[2] ?? "") as Input
const originalRun = Database.prototype.run
const originalSerialize = Database.prototype.serialize
const originalBufferToString = Buffer.prototype.toString
let serializations = 0

Buffer.prototype.toString = function (...args: Parameters<Buffer["toString"]>) {
  if (input.observeBase64 && args[0] === "base64") {
    writeFileSync(input.observeBase64, "base64 identity called", { flag: "wx" })
  }
  return originalBufferToString.apply(this, args)
}

Database.prototype.run = function (...args: Parameters<Database["run"]>) {
  const result = originalRun.apply(this, args)
  const sql = String(args[0]).trim().toUpperCase()
  if (input.crash === "pre-sanitize" && sql.startsWith("VACUUM INTO ")) process.kill(process.pid, "SIGKILL")
  if (input.crash === "post-sanitize" && sql === "VACUUM") process.kill(process.pid, "SIGKILL")
  return result
}

Database.prototype.serialize = function (...args: Parameters<Database["serialize"]>) {
  const result = originalSerialize.apply(this, args)
  if (input.observeSerialize) writeFileSync(input.observeSerialize, "serialize called", { flag: "wx" })
  serializations += 1
  if (input.crash === "pre-sanitize" && serializations === 1) process.kill(process.pid, "SIGKILL")
  if (input.crash === "post-sanitize" && serializations === 2) process.kill(process.pid, "SIGKILL")
  return result
}

const rssBefore = process.memoryUsage().rss
try {
  const captured = await captureMigrationSource(input.source, input.destination)
  process.stdout.write(
    JSON.stringify(input.reportFailure ? { captured, rssBefore, rssAfter: process.memoryUsage().rss } : captured),
  )
} catch (error) {
  if (!input.reportFailure) throw error
  process.stdout.write(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown migration capture failure.",
      rssBefore,
      rssAfter: process.memoryUsage().rss,
    }),
  )
}
