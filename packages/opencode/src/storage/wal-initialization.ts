import { StorageSQLite } from "#storage-sqlite"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import path from "node:path"
import { withMigrationMaintenanceLockSync } from "./migration-maintenance-lock"

// Startup only: macOS SQLite can reject a read-only WAL database when both
// companion files are absent. Let SQLite initialize them before read-only
// diagnosis. Never synthesize/delete journals or use immutable live reads.
export function withInitializedWalFiles<T>(file: string, operation: () => T): T {
  const missing = (entry: string) => {
    try {
      lstatSync(entry)
      return false
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true
      throw error
    }
  }
  if (missing(file) || !missing(`${file}-wal`) || !missing(`${file}-shm`)) return operation()
  const parent = lstatSync(path.dirname(file))
  const original = lstatSync(file)
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o022) !== 0 ||
    !original.isFile() ||
    original.isSymbolicLink() ||
    original.nlink !== 1 ||
    (original.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && (parent.uid !== process.getuid() || original.uid !== process.getuid()))
  ) {
    throw new Error("BharatCode database initialization requires privately owned storage.")
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const held = fstatSync(descriptor)
    if (held.dev !== original.dev || held.ino !== original.ino) throw changed()
    const header = Buffer.alloc(20)
    if (
      readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString() !== "SQLite format 3\0" ||
      header[18] !== 2 ||
      header[19] !== 2
    )
      return operation()

    return withMigrationMaintenanceLockSync(path.dirname(file), () => {
      const current = lstatSync(file)
      const directory = lstatSync(path.dirname(file))
      if (
        current.dev !== held.dev ||
        current.ino !== held.ino ||
        current.mode !== original.mode ||
        current.uid !== original.uid ||
        current.nlink !== 1 ||
        directory.dev !== parent.dev ||
        directory.ino !== parent.ino ||
        directory.mode !== parent.mode ||
        directory.uid !== parent.uid
      )
        throw changed()
      if (!missing(`${file}-wal`) || !missing(`${file}-shm`)) return operation()
      const database = new StorageSQLite(file, { readwrite: true, create: false })
      try {
        database.run("PRAGMA busy_timeout = 5000")
        database.run("PRAGMA query_only = ON")
        const rows = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
        if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
          throw new Error("BharatCode database integrity verification failed.")
        }
        // Keep the connection alive through diagnosis: some SQLite builds
        // remove the companion files when their last connection closes.
        const result = operation()
        const after = lstatSync(file)
        if (after.dev !== held.dev || after.ino !== held.ino) throw changed()
        return result
      } finally {
        database.close()
      }
    })
  } finally {
    closeSync(descriptor)
  }
}

function changed() {
  return new Error("BharatCode database changed during initialization. Close other instances and retry.")
}
