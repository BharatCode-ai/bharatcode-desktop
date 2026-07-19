import { Database } from "bun:sqlite"

export class StorageSQLite {
  readonly #database: Database

  constructor(file: string, options?: { readonly?: boolean; create?: boolean }) {
    this.#database = new Database(file, options)
  }

  run(sql: string) {
    this.#database.run(sql)
  }

  query(sql: string) {
    return this.#database.query(sql)
  }

  close() {
    this.#database.close()
  }
}
