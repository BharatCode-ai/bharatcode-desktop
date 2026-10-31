import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveSupportPaths } from "./support-metadata"

for (const platform of ["linux", "darwin", "win32"] as const) {
  for (const channel of ["dev", "beta", "prod"] as const) {
    test(`${platform}/${channel} resolves branded channel paths and overrides`, () => {
      const home = platform === "win32" ? "C:\\Users\\private" : "/home/private"
      const paths = resolveSupportPaths({ platform, channel, home, temp: home, env: {} })
      expect(paths.database).toContain(
        channel === "prod" ? "BharatCode" : `BharatCode ${channel === "dev" ? "Dev" : "Beta"}`,
      )
      const custom = resolveSupportPaths({
        platform,
        channel,
        home,
        temp: home,
        env: { BHARATCODE_CONFIG_DIR: "private-config", OPENCODE_CONFIG: "private.json", OPENCODE_DB: ":memory:" },
      })
      expect(custom.config).toBe("private-config")
      expect(custom.override).toBe("private.json")
      expect(custom.database).toBe(":memory:")
    })
  }
}

test("storage resolution honors sidecar channel/home while retaining the app update channel", () => {
  const paths = resolveSupportPaths({
    channel: "beta",
    platform: "linux",
    home: "/tmp/original",
    temp: "/tmp",
    env: { BHARATCODE_CHANNEL: "prod", OPENCODE_TEST_HOME: "/tmp/isolated" },
  })
  expect(paths.database).toBe("/tmp/isolated/.local/share/BharatCode/bharatcode.db")
  expect(paths.config).toBe("/tmp/isolated/.config/BharatCode")
})

test("real Node collector reads only metadata and handles missing, legacy, malformed, and locked databases", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-metadata-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("./support-metadata.ts"))],
      outdir: root,
      target: "node",
      format: "esm",
      naming: "metadata.mjs",
    })
    expect(build.success).toBe(true)
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
      import path, { join } from 'node:path';
      const { collectSupportMetadata, resolveSupportPaths } = await import(${JSON.stringify(pathToFileURL(join(root, "metadata.mjs")).href)});
      const home = ${JSON.stringify(root)};
      const input = { channel: 'beta', platform: 'linux', home, temp: home, env: { XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') } };
      const paths = resolveSupportPaths(input);
      const missing = await collectSupportMetadata(input);
      assert.equal(missing.database.availability, 'missing');
      assert.equal(missing.config.directory, false);
      assert.equal((await readdir(home)).length, 1);
      await mkdir(paths.config, { recursive: true });
      await mkdir(paths.data, { recursive: true });
      for (const file of ['opencode.json', 'opencode.jsonc', 'config.json']) await writeFile(join(paths.config, file), 'sk-secret-private-email@example.test');
      await writeFile(paths.auth, 'sk-secret-private-credential');
      let db = new DatabaseSync(paths.database);
      db.exec("CREATE TABLE migration(id TEXT, time_completed INTEGER); INSERT INTO migration VALUES('20260919234912_add_goal_mode', 1); CREATE TABLE messages(content TEXT); INSERT INTO messages VALUES('raw private prompt');");
      db.close();
      const before = await readFile(paths.database);
      const result = await collectSupportMetadata(input);
      assert.equal(result.database.availability, 'available');
      assert.equal(result.database.migrationFormat, 'current');
      assert.equal(result.database.appliedCount, 1);
      assert.equal(result.database.latestMigration, 20260919234912);
      assert.equal(result.config.authStore, true);
      assert.equal(result.config.globalJson, true);
      assert.deepEqual(await readFile(paths.database), before);
      assert(!JSON.stringify(result).includes(home));
      assert(!JSON.stringify(result).includes('sk-secret'));
      db = new DatabaseSync(paths.database);
      db.exec("DELETE FROM migration; CREATE TABLE __drizzle_migrations(name TEXT); INSERT INTO __drizzle_migrations VALUES('20260101000000_named')");
      db.close();
      assert.equal((await collectSupportMetadata(input)).database.migrationFormat, 'legacy');
      assert.equal((await collectSupportMetadata(input)).database.latestMigration, 20260101000000);
      db = new DatabaseSync(paths.database);
      db.exec('DROP TABLE __drizzle_migrations; CREATE TABLE __drizzle_migrations(id INTEGER, created_at INTEGER); INSERT INTO __drizzle_migrations VALUES(1, 1767225600000)');
      db.close();
      assert.equal((await collectSupportMetadata(input)).database.latestMigration, 20260101000000);
      assert.equal((await collectSupportMetadata(input)).database.migrationFormat, 'legacy');
      db = new DatabaseSync(paths.database);
      db.exec('DROP TABLE migration; DROP TABLE __drizzle_migrations; CREATE TABLE migration(unexpected TEXT)'); db.close();
      assert.equal((await collectSupportMetadata(input)).database.migrationFormat, 'unknown');
      db = new DatabaseSync(paths.database); db.exec('DROP TABLE migration'); db.close();
      assert.equal((await collectSupportMetadata(input)).database.appliedCount, null);
      db = new DatabaseSync(paths.database); db.exec("BEGIN EXCLUSIVE; INSERT INTO messages VALUES('uncommitted private prompt')");
      assert.equal((await collectSupportMetadata(input)).database.availability, 'unavailable');
      db.exec('ROLLBACK'); db.close();
      const walFile = join(home, 'wal.db');
      const walInput = {...input, env: {...input.env, OPENCODE_DB: walFile}};
      db = new DatabaseSync(walFile);
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE migration(id TEXT); INSERT INTO migration VALUES('20260101000000_initial')");
      db.close();
      const closedFiles = (await readdir(home)).sort();
      const closedBytes = await readFile(walFile);
      assert.equal((await collectSupportMetadata(walInput)).database.latestMigration, 20260101000000);
      assert.deepEqual((await readdir(home)).sort(), closedFiles);
      assert.deepEqual(await readFile(walFile), closedBytes);
      db = new DatabaseSync(walFile);
      db.exec("INSERT INTO migration VALUES('20260202000000_live')");
      const activeFiles = (await readdir(home)).sort();
      const beforeWal = await readFile(walFile + '-wal');
      const beforeShm = await readFile(walFile + '-shm');
      assert.equal((await collectSupportMetadata(walInput)).database.availability, 'unavailable');
      assert.deepEqual((await readdir(home)).sort(), activeFiles);
      assert.deepEqual(await readFile(walFile + '-wal'), beforeWal);
      assert.deepEqual(await readFile(walFile + '-shm'), beforeShm);
      db.close();
      const isolated = {...input, env: {BHARATCODE_CHANNEL: 'prod', OPENCODE_TEST_HOME: join(home, 'isolated')}};
      const isolatedPaths = resolveSupportPaths(isolated);
      await mkdir(isolatedPaths.data, {recursive: true});
      db = new DatabaseSync(isolatedPaths.database);
      db.exec("CREATE TABLE migration(id TEXT); INSERT INTO migration VALUES('20260303000000_isolated')");
      db.close();
      assert.equal((await collectSupportMetadata(isolated)).database.latestMigration, 20260303000000);
      assert.equal((await collectSupportMetadata(input)).database.latestMigration, null);
      await writeFile(paths.database, 'not sqlite sk-secret');
      assert.equal((await collectSupportMetadata(input)).database.availability, 'unavailable');
      assert.equal((await collectSupportMetadata({...input, env: {...input.env, OPENCODE_DB: ':memory:'}})).database.availability, 'memory');
      assert.equal(resolveSupportPaths({...input, env: {...input.env, OPENCODE_DB: 'custom.db'}}).database, (input.platform === 'win32' ? path.win32 : path.posix).join(paths.data, 'custom.db'));
      assert.equal(resolveSupportPaths({...input, env: {...input.env, OPENCODE_DB: join(home, 'absolute.db')}}).database, join(home, 'absolute.db'));
      console.log('metadata fixtures passed');
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    )
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 })
    expect(child.stdout).toContain("metadata fixtures passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
