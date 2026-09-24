// Real current schema for the Node SQLite import regression fixture.
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import schema from "@opencode-ai/core/database/schema.gen"

export async function createChatFixture(file: string) {
  const db = new DatabaseSync(file)
  const tx = { run: (sql: string) => Effect.sync(() => db.exec(sql)) }
  await Effect.runPromise(schema.up(tx as unknown as Parameters<typeof schema.up>[0]))
  return db
}
