import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "@opencode-ai/core/util/windows-credential-store"
import * as NativeStore from "@opencode-ai/core/util/windows-credential-store"
import {
  diagnoseSchemaMarker,
  releasedSchemaCandidatesFromMigrations,
  repairSchemaMarker,
} from "@/storage/schema-marker"
import { quarantineWindowsMarker } from "@/storage/schema-marker.windows"

const native = test.skipIf(process.platform !== "win32")
const sql = "CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT NOT NULL)"

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bc-marker-native-")))
  const marker = path.join(root, "private", ".schema-version")
  windowsCredentialStore(marker).prepareParent()
  const databasePath = path.join(path.dirname(marker), "bharatcode.db")
  const database = new Database(databasePath, { create: true })
  database.run(sql)
  database.close()
  const input = {
    databasePath,
    candidates: releasedSchemaCandidatesFromMigrations([{ version: "v1", sql }]),
    open: (file: string, options: { readonly: boolean }) => {
      const db = new Database(file, options)
      return { rows: (query: string) => db.query(query).all() as Record<string, unknown>[], close: () => db.close() }
    },
  }
  const digest = async () =>
    createHash("sha256")
      .update(await readFile(databasePath))
      .digest("hex")
  return { root, marker, input, digest, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) }
}

native(
  "native private marker is healthy despite Windows synthetic 0666 mode",
  async () => {
    await using f = await fixture()
    await writeFile(f.marker, "v1\n", { mode: 0o600 })
    expect((await lstat(f.marker)).mode & 0o777).toBe(0o666)
    const before = await f.digest()
    expect(diagnoseSchemaMarker(f.input)).toEqual({ state: "healthy", inferredVersion: "v1" })
    expect(await f.digest()).toBe(before)
  },
  30_000,
)

native(
  "native missing/invalid marker publication and quarantine survive a new diagnosis without touching DB",
  async () => {
    await using f = await fixture()
    const before = await f.digest()
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("repaired")
    expect(diagnoseSchemaMarker(f.input).state).toBe("healthy")
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("unchanged")
    await writeFile(f.marker, "broken")
    const result = repairSchemaMarker({ ...f.input, confirmed: true })
    expect(result.state).toBe("repaired")
    expect(result.quarantine).toBeString()
    expect(await readFile(result.quarantine!, "utf8")).toBe("broken")
    expect(await readFile(f.marker, "utf8")).toBe("v1\n")
    expect(diagnoseSchemaMarker(f.input).state).toBe("healthy")
    expect(await f.digest()).toBe(before)
  },
  90_000,
)

native(
  "native marker does not accept unrelated ACL grants, links or directories as a mode-check workaround",
  async () => {
    await using f = await fixture()
    await writeFile(f.marker, "v1\n")
    const acl = spawnSync("icacls.exe", [f.marker, "/grant", "*S-1-1-0:R"], { windowsHide: true, encoding: "utf8" })
    expect(acl.status).toBe(0)
    expect(diagnoseSchemaMarker(f.input).state).toBe("permission-invalid")
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("failed")
    expect(await readFile(f.marker, "utf8")).toBe("v1\n")
    await rm(f.marker)
    const outside = path.join(f.root, "outside")
    await writeFile(outside, "v1\n")
    await link(outside, f.marker)
    expect(diagnoseSchemaMarker(f.input).state).toBe("permission-invalid")
    await rm(f.marker)
    await mkdir(f.marker)
    expect(diagnoseSchemaMarker(f.input).state).toBe("invalid")
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("failed")
    expect((await lstat(f.marker)).isDirectory()).toBe(true)
  },
  30_000,
)

native(
  "native marker rejects a substituted junction parent without changing the valid target",
  async () => {
    await using f = await fixture()
    await writeFile(f.marker, "v1\n")
    const junction = path.join(f.root, "junction")
    await symlink(path.dirname(f.marker), junction, "junction")
    expect(diagnoseSchemaMarker({ ...f.input, databasePath: path.join(junction, "bharatcode.db") }).state).toBe(
      "permission-invalid",
    )
    expect(await readFile(f.marker, "utf8")).toBe("v1\n")
  },
  30_000,
)

native(
  "native quarantine fails closed on destination collision and unconfirmed helper completion",
  async () => {
    await using f = await fixture()
    await writeFile(f.marker, "broken")
    const destination = `${f.marker}.quarantine-existing`
    await writeFile(destination, "preserved")
    expect(() => quarantineWindowsMarker(f.marker, destination)).toThrow("not confirmed")
    expect(await readFile(f.marker, "utf8")).toBe("broken")
    expect(await readFile(destination, "utf8")).toBe("preserved")
    const spawn: typeof spawnSync = (() => ({
      status: null,
      error: new Error("synthetic timeout"),
      stdout: "",
      stderr: "",
    })) as unknown as typeof spawnSync
    expect(() => quarantineWindowsMarker(f.marker, `${f.marker}.quarantine-timeout`, spawn)).toThrow("not confirmed")
    expect(await readFile(f.marker, "utf8")).toBe("broken")
  },
  30_000,
)

native(
  "native unsafe parent fails publication without silently creating a marker or changing the DB",
  async () => {
    await using f = await fixture()
    const before = await f.digest()
    const acl = spawnSync("icacls.exe", [path.dirname(f.marker), "/grant", "*S-1-1-0:R"], {
      windowsHide: true,
      encoding: "utf8",
    })
    expect(acl.status).toBe(0)
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("failed")
    expect(await Bun.file(f.marker).exists()).toBe(false)
    expect(await f.digest()).toBe(before)
  },
  30_000,
)

native(
  "native post-publication schema drift quarantines the marker and never reports success",
  async () => {
    await using f = await fixture()
    let opens = 0
    const result = repairSchemaMarker({
      ...f.input,
      confirmed: true,
      open: (file, options) => {
        if (++opens === 2) {
          const changed = new Database(file)
          changed.run("CREATE TABLE unexpected(id INTEGER)")
          changed.close()
        }
        return f.input.open(file, options)
      },
    })
    expect(result.state).toBe("failed")
    expect(await Bun.file(f.marker).exists()).toBe(false)
    expect(result.quarantine).toBeString()
  },
  30_000,
)

native(
  "native marker cannot bless an incompatible schema",
  async () => {
    await using f = await fixture()
    await writeFile(f.marker, "v1\n")
    const changed = new Database(f.input.databasePath)
    changed.run("CREATE TABLE unexpected(id INTEGER)")
    changed.close()
    expect(diagnoseSchemaMarker(f.input).state).toBe("schema-mismatch")
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("failed")
    expect(await readFile(f.marker, "utf8")).toBe("v1\n")
  },
  30_000,
)

native(
  "native quarantine rejects a replaced leaf even when replacement bytes match",
  async () => {
    await using f = await fixture()
    await writeFile(f.marker, "broken")
    const saved = `${f.marker}.saved`
    const destination = `${f.marker}.quarantine-substitution`
    const swap: typeof spawnSync = ((command: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
      renameSync(f.marker, saved)
      writeFileSync(f.marker, "broken")
      return spawnSync(command, args, options)
    }) as typeof spawnSync
    expect(() => quarantineWindowsMarker(f.marker, destination, swap)).toThrow("not confirmed")
    expect(await readFile(f.marker, "utf8")).toBe("broken")
    expect(await readFile(saved, "utf8")).toBe("broken")
    expect(await Bun.file(destination).exists()).toBe(false)
  },
  30_000,
)

native(
  "native publication followed by lost confirmation remains failed and requires fresh full diagnosis",
  async () => {
    await using f = await fixture()
    const original = NativeStore.windowsCredentialStore
    const fault = spyOn(NativeStore, "windowsCredentialStore").mockImplementation((file, options) => {
      const store = original(file, options)
      return {
        ...store,
        publish: (content: string) => {
          store.publish(content)
          throw new Error("Synthetic lost confirmation after actual native publication")
        },
      }
    })
    try {
      const result = repairSchemaMarker({ ...f.input, confirmed: true })
      expect(result.state).toBe("failed")
      expect(await readFile(f.marker, "utf8")).toBe("v1\n")
    } finally {
      fault.mockRestore()
    }
    expect(diagnoseSchemaMarker(f.input)).toEqual({ state: "healthy", inferredVersion: "v1" })
    expect(repairSchemaMarker({ ...f.input, confirmed: true }).state).toBe("unchanged")
  },
  30_000,
)
