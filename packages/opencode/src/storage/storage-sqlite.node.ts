import { DatabaseSync } from "node:sqlite"

export class StorageSQLite {
  readonly #database: DatabaseSync

  constructor(file: string, options?: { readonly?: boolean; create?: boolean }) {
    this.#database = new DatabaseSync(file, {
      readOnly: options?.readonly === true,
    })
  }

  run(sql: string) {
    this.#database.exec(sql)
  }

  query(sql: string) {
    return { all: () => this.#database.prepare(sql).all() }
  }

  close() {
    this.#database.close()
  }
}
