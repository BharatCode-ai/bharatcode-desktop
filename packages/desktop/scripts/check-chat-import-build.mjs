// Isolated packaged-worker check. Run after electron-vite build; no user profile.
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"

const home = mkdtempSync(join(tmpdir(), "bc-chat-worker-"))
try {
  const data = join(home, "data")
  const old = join(data, "bharatcode-beta")
  mkdirSync(old, { recursive: true })
  const db = new DatabaseSync(join(old, "bharatcode.db"))
  db.exec(`
    CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT, sandboxes TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO project VALUES('project','/synthetic','[]',1,1);
    CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session VALUES('ses_test','project','test','/synthetic','Synthetic chat','1.15.28',1,1);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO message VALUES('msg_test','ses_test',1,1,'{"role":"user","time":{"created":1}}');
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO part VALUES('prt_test','msg_test','ses_test',1,1,'{"type":"text","text":"synthetic"}');
  `)
  db.close()
  const worker = pathToFileURL(resolve("out/main/chat-import-worker.js")).href
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    process.parentPort={postMessage(value){console.log(JSON.stringify(value))}};
    await import(${JSON.stringify(worker)});
  `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          OPENCODE_TEST_HOME: home,
          XDG_DATA_HOME: data,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_STATE_HOME: join(home, "state"),
          XDG_CACHE_HOME: join(home, "cache"),
          BHARATCODE_CHANNEL: "beta",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    )
  const first = run()
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /"imported":1/)
  const second = run()
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /"imported":0/)
  console.log("COMPILED_CHAT_IMPORT_PASS")
} finally {
  rmSync(home, { recursive: true, force: true })
}
