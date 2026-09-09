import { StorageSQLite } from "#storage-sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { windowsCredentialStore } from "@opencode-ai/core/util/windows-credential-store"

export class MigrationMaintenanceLockError extends Error {
  constructor() {
    super("BharatCode migration maintenance is already active.")
    this.name = "BharatCodeMigrationMaintenanceLockError"
  }
}

export async function withMigrationMaintenanceLock<T>(stateRoot: string, operation: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") windowsCredentialStore(path.join(stateRoot, "auth.json")).prepareParent()
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const database = new StorageSQLite(path.join(stateRoot, "lean-migration-maintenance.sqlite"), { create: true })
  database.run("PRAGMA busy_timeout = 50")
  const acquired = await acquire(database)
  if (!acquired) {
    database.close()
    throw new MigrationMaintenanceLockError()
  }
  try {
    const result = await operation()
    database.run("COMMIT")
    return result
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {}
    throw error
  } finally {
    database.close()
  }
}

export function withMigrationMaintenanceLockSync<T>(root: string, operation: () => T): T {
  const database = new StorageSQLite(path.join(root, "lean-migration-maintenance.sqlite"), { create: true })
  database.run("PRAGMA busy_timeout = 5000")
  try {
    database.run("BEGIN IMMEDIATE")
    const result = operation()
    database.run("COMMIT")
    return result
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {}
    throw error
  } finally {
    database.close()
  }
}

async function acquire(database: StorageSQLite) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      database.run("BEGIN IMMEDIATE")
      return true
    } catch (error) {
      if (!sqliteBusy(error)) throw error
      await Bun.sleep(Math.min(10 + attempt * 2, 100))
    }
  }
  return false
}

function sqliteBusy(error: unknown) {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)
}

export * as MigrationMaintenanceLock from "./migration-maintenance-lock"
