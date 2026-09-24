import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("automatic chat import preserves current chats, projects, history, source WAL and retry safety", async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "bc-chat-import-test-"))
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(import.meta.resolve("./chat-import.ts")),
        fileURLToPath(import.meta.resolve("./chat-import.fixture.ts")),
      ],
      outdir: home,
      target: "node",
      format: "esm",
      naming: "[name].mjs",
    })
    expect(build.success).toBe(true)
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { readFileSync, readdirSync, symlinkSync } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const { importPreviousChats } = await import(${JSON.stringify(pathToFileURL(join(home, "chat-import.mjs")).href)});
      const { createChatFixture } = await import(${JSON.stringify(pathToFileURL(join(home, "chat-import.fixture.mjs")).href)});
      const source = ${JSON.stringify(join(home, "old.db"))};
      const destination = ${JSON.stringify(join(home, "new.db"))};
      const old = await createChatFixture(source);
      const current = await createChatFixture(destination);
      const project = (db, name) => db.prepare("INSERT INTO project (id,worktree,name,time_created,time_updated,sandboxes) VALUES ('project','/project',?,1,1,'[]')").run(name);
      const session = (db, id, title) => db.prepare("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,'project','slug','/project',?,'1.15.28',1,1)").run(id,title);
      project(old,'old'); project(current,'current');
      session(old,'ses_old','old chat'); session(old,'ses_existing','stale chat'); session(current,'ses_existing','current chat');
      old.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      const msg = old.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)');
      msg.run('msg_user','ses_old',1,1,JSON.stringify({role:'user',time:{created:1}}));
      msg.run('msg_assistant','ses_old',2,3,JSON.stringify({role:'assistant',agent:'build',modelID:'model',providerID:'provider',time:{created:2,completed:3},tokens:{input:2,output:3,reasoning:0,cache:{read:0,write:0}},cost:0}));
      const part = old.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)');
      part.run('prt_user','msg_user','ses_old',1,1,JSON.stringify({type:'text',text:'hello'}));
      part.run('prt_answer','msg_assistant','ses_old',2,3,JSON.stringify({type:'text',text:'answer'}));
      part.run('prt_tool','msg_assistant','ses_old',2,3,JSON.stringify({type:'tool',callID:'call1',tool:'read',state:{status:'completed',input:{file:'a'},output:'saved result',time:{start:2,end:3}}}));
      // Older releases kept switches in a separate projection, with older ID prefixes.
      old.prepare('INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)').run('old_switch','ses_old','model-switched',0,0,0,JSON.stringify({model:{id:'model',providerID:'provider'},time:{created:0}}));
      const bytes = readFileSync(source);
      assert.deepEqual(await importPreviousChats(source,destination),{imported:1,skipped:1});
      assert.deepEqual(readFileSync(source),bytes);
      assert.equal(current.prepare("SELECT title FROM session WHERE id='ses_existing'").get().title,'current chat');
      assert.equal(current.prepare("SELECT name FROM project WHERE id='project'").get().name,'current');
      assert.equal(current.prepare('SELECT count(*) n FROM message').get().n,2);
      const projected = current.prepare("SELECT data FROM session_message WHERE id='msg_assistant'").get();
      assert.equal(JSON.parse(projected.data).content[0].text,'answer');
      assert.equal(JSON.parse(projected.data).content[1].state.content[0].text,'saved result');
      assert.equal(current.prepare("SELECT seq FROM event_sequence WHERE aggregate_id='ses_old'").get().seq,3);
      assert.equal(current.prepare("SELECT count(*) n FROM session_message WHERE type='model-switched'").get().n,1);
      assert.deepEqual(await importPreviousChats(source,destination),{imported:0,skipped:0});
      assert.equal(current.prepare('SELECT count(*) n FROM session').get().n,2);
      const backups = readdirSync(${JSON.stringify(join(home, "chat-import-backups"))});
      assert.equal(backups.length,1);
      const snapshot = new DatabaseSync(${JSON.stringify(join(home, "chat-import-backups"))}+'/'+backups[0],{readOnly:true});
      assert.equal(snapshot.prepare('SELECT count(*) n FROM session').get().n,1); snapshot.close();
      // An invalid message must roll back the entire source, including its receipt.
      const broken = ${JSON.stringify(join(home, "broken.db"))};
      const bad = await createChatFixture(broken); project(bad,'bad'); session(bad,'ses_bad','bad chat');
      bad.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)').run('msg_bad','ses_bad',1,1,'broken json');
      await assert.rejects(importPreviousChats(broken,destination));
      assert.equal(current.prepare("SELECT count(*) n FROM session WHERE id='ses_bad'").get().n,0);
      assert.equal(current.prepare('SELECT count(*) n FROM bharatcode_chat_import').get().n,1);
      bad.prepare('UPDATE message SET data=?').run(JSON.stringify({role:'user',time:{created:1}}));
      assert.equal((await importPreviousChats(broken,destination)).imported,1);
      // No custom source or absent DB is created, and no same-file import.
      assert.deepEqual(await importPreviousChats(destination,destination),{imported:0,skipped:0});
      assert.deepEqual(await importPreviousChats(${JSON.stringify(join(home, "missing.db"))},destination),{imported:0,skipped:0});
      const link = ${JSON.stringify(join(home, "linked.db"))}; symlinkSync(source,link);
      await assert.rejects(importPreviousChats(link,destination));
      old.close(); current.close(); bad.close();
      console.log('CHAT_IMPORT_PASS');
    `,
      ],
      { encoding: "utf8", timeout: 60_000 },
    )
    expect(child.stderr).not.toContain("AssertionError")
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain("CHAT_IMPORT_PASS")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 90_000)
