import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js"

test("real initialized runtime exports active-WAL metadata without reading or changing database files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-live-"))
  try {
    const source = (name: string) => fileURLToPath(new URL(name, import.meta.url))
    await writeFile(
      join(root, "entry.ts"),
      [
        `export { exportDebugLogs } from ${JSON.stringify(source("./logging.ts"))}`,
        `export { supportRuntimeDatabase } from ${JSON.stringify(source("./support-runtime-database.ts"))}`,
        `export { captureSupportDatabase } from ${JSON.stringify(source("../../../opencode/src/server/support-database.ts"))}`,
        `export { Database } from ${JSON.stringify(source("../../../core/src/database/database.ts"))}`,
        `export { Effect } from ${JSON.stringify(fileURLToPath(import.meta.resolve("effect")))}`,
        `export { sql } from ${JSON.stringify(fileURLToPath(import.meta.resolve("drizzle-orm")))}`,
      ].join("\n"),
    )
    const build = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const result = await Bun.build({ entrypoints: [${JSON.stringify(join(root, "entry.ts"))}], outdir: ${JSON.stringify(root)}, target: 'node', format: 'esm', naming: 'live.mjs',
        define: { 'import.meta.env.OPENCODE_CHANNEL': '"beta"' },
        plugins: [{ name: 'electron-fixture', setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, args => ({ path: args.path, namespace: 'fixture' }));
          builder.onResolve({ filter: /^electron-log/ }, args => ({ path: args.path, namespace: 'fixture' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
            ? "export const app = { getPath: () => process.env.BC_SUPPORT_HOME, getVersion: () => '1.2.3' }; export const shell = { showItemInFolder: () => {} }; export const netLog = {}; export const crashReporter = {};"
            : "export default {};", loader: 'js' }));
        }}],
      });
      if (!result.success) { console.error(result.logs); process.exit(1); }
    `,
      ],
      { encoding: "utf8", timeout: 20000 },
    )
    expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: "" })
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import {readFile,readdir} from 'node:fs/promises';
      const {exportDebugLogs,supportRuntimeDatabase,captureSupportDatabase,Database,Effect,sql} = await import(${JSON.stringify(pathToFileURL(join(root, "live.mjs")).href)});
      const file = process.env.OPENCODE_DB;
      await Effect.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service;
        yield* database.db.run(sql.raw("CREATE TABLE private_fixture(content TEXT)"));
        yield* database.db.run(sql.raw("INSERT INTO private_fixture VALUES ('sk-private owner@private.test https://github.com/private/repo private-prompt')"));
        const captured = yield* captureSupportDatabase();
        assert.equal(captured.availability, 'available');
        const owner = supportRuntimeDatabase.attach(); owner.publish(captured);
        // A normal committed write after startup leaves live data in WAL; metadata remains the startup snapshot.
        yield* database.db.run(sql.raw("INSERT INTO private_fixture VALUES ('oauth-private-refresh')"));
        const before = yield* Effect.promise(() => Promise.all(['','-wal','-shm'].map(suffix => readFile(file + suffix))));
        assert(before[1].length > 0);
        const directory = (yield* Effect.promise(() => readdir(process.env.BC_SUPPORT_HOME))).sort();
        const output = yield* Effect.promise(() => exportDebugLogs());
        const after = yield* Effect.promise(() => Promise.all(['','-wal','-shm'].map(suffix => readFile(file + suffix))));
        before.forEach((bytes,index) => assert.deepEqual(after[index],bytes));
        const added = (yield* Effect.promise(() => readdir(process.env.BC_SUPPORT_HOME))).filter(name => !directory.includes(name));
        assert.deepEqual(added,[output.split('/').at(-1)]);
        console.log(JSON.stringify({output,captured}));
        owner.dispose(); assert.equal(supportRuntimeDatabase.read(),undefined);
      }).pipe(Effect.provide(Database.layerFromPath(file)),Effect.scoped));
    `,
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          BC_SUPPORT_HOME: root,
          OPENCODE_DB: join(root, "fixture.db"),
          OPENCODE_TEST_HOME: root,
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
        },
      },
    )
    expect({ status: child.status, stderr: child.stderr.slice(-4000) }).toMatchObject({ status: 0 })
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "")
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(result.output))))
    try {
      const entries = await reader.getEntries()
      expect(entries.map((entry) => entry.filename)).toEqual(["support-bundle.json"])
      const entry = entries[0]
      if (entry.directory) throw new Error("expected JSON")
      const text = await entry.getData!(new TextWriter())
      expect(JSON.parse(text).database).toEqual(result.captured)
      expect(JSON.parse(text).database.appliedCount).toBeGreaterThan(0)
      for (const secret of [
        "sk-private",
        "owner@private.test",
        "https://github.com/private/repo",
        "private-prompt",
        "oauth-private-refresh",
        root,
      ])
        expect(text).not.toContain(secret)
    } finally {
      await reader.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 45000)
