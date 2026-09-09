import { DatabaseSync } from "node:sqlite"

export function open(file: string) {
  const database = new DatabaseSync(file)
  try {
    database.exec("PRAGMA busy_timeout = 0")
  } catch (error) {
    try {
      database.close()
    } catch {
      // The original setup error is the actionable failure.
    }
    throw error
  }
  return {
    exec: (sql: string) => database.exec(sql),
    close: () => database.close(),
  }
}
