import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

test("compiled Node sidecar migrates marketplace before serving protected signed-out state", async () => {
  const home = await mkdtemp(join(tmpdir(), "bharatcode-node-smoke-"))
  const moduleUrl = pathToFileURL(resolve("../opencode/dist/node/node.js")).href
  // Match electron.vite.config's native PTY external resolution; the intermediate
  // Node bundle is emitted under opencode, while Desktop owns these dependencies.
  const pty = import.meta.resolve(`@lydell/node-pty-${process.platform}-${process.arch}`)
  try {
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import {mkdir,writeFile,readFile} from "node:fs/promises";
      import path from "node:path";
      registerHooks({resolve(specifier,context,next) {
        if (specifier === "@lydell/node-pty") return {url:${JSON.stringify(pty)},shortCircuit:true};
        return next(specifier,context);
      }});
      const { Server, migrateDesktopCapabilities } = await import(${JSON.stringify(moduleUrl)});
      const userData = path.join(process.env.HOME,"electron");
      await mkdir(userData,{mode:0o700});
      const source = path.join(userData,"bharatcode.capabilities");
      const old = JSON.stringify({"state.v1":{version:1,installed:{
        "superpowers-obra":{id:"superpowers-obra",enabled:false},
        github:{id:"github",enabled:false}
      }}});
      await writeFile(source,old,{mode:0o600});
      await migrateDesktopCapabilities(userData);
      assert.equal(await readFile(source,"utf8"),old);
      await writeFile(source,"malformed source after committed import");
      await migrateDesktopCapabilities(userData);
      const server = await Server.listen({hostname:"127.0.0.1",port:0});
      try {
        const status = new URL("/account/status",server.url);
        assert.equal((await fetch(status)).status,401);
        const reply = await fetch(status,{headers:{authorization:"Basic "+Buffer.from("opencode:synthetic-smoke-only").toString("base64")}});
        assert.equal(reply.status,200);
        const account = await reply.json();
        assert.equal(account.state,"signed-out");
        assert.equal(account.access_token,undefined);
        const capabilities = await fetch(new URL("/capabilities",server.url),{headers:{authorization:"Basic "+Buffer.from("opencode:synthetic-smoke-only").toString("base64")}});
        assert.equal(capabilities.status,200);
        const snapshot = await capabilities.json();
        assert.equal(snapshot.state.installed["superpowers-obra"].enabled,false);
        assert.equal(snapshot.state.installed.github.enabled,false);
        assert.equal(snapshot.state.legacy,undefined);
        console.log("COMPILED_ACCOUNT_PASS");
      } finally { await server.stop(true); }
      process.exit(0);
    `,
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          OPENCODE_TEST_HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          XDG_STATE_HOME: join(home, "state"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_CLIENT: "desktop",
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: "synthetic-smoke-only",
        },
        encoding: "utf8",
        timeout: 45_000,
      },
    )
    expect({ status: child.status, stderr: child.stderr.slice(-4000) }).toMatchObject({ status: 0 })
    expect(child.stdout).toContain("COMPILED_ACCOUNT_PASS")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 50_000)

test("Desktop drafts and referenced blobs survive a real Node SQLite close/reopen", async () => {
  const home = await mkdtemp(join(tmpdir(), "bharatcode-draft-smoke-"))
  try {
    const build = await Bun.build({
      entrypoints: ["./src/main/draft-store.ts"],
      outdir: home,
      target: "node",
      format: "esm",
      naming: "draft-store.mjs",
    })
    expect(build.success).toBe(true)
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const {createDesktopDraftStore} = await import(${JSON.stringify(pathToFileURL(join(home, "draft-store.mjs")).href)});
      const path = ${JSON.stringify(join(home, "drafts.sqlite"))};
      const first = createDesktopDraftStore(path);
      const bytes = Buffer.from("synthetic attachment");
      const id = first.putBlob(bytes);
      const draft = JSON.stringify({text:"latest",attachment:{blob:{id}}});
      first.set("prompt",JSON.stringify({text:"first"}));
      first.set("prompt",draft);
      first.close();
      const reopened = createDesktopDraftStore(path);
      assert.equal(reopened.get("prompt"),draft);
      assert.deepEqual(Buffer.from(reopened.getBlob(id)),bytes);
      reopened.close();
      console.log("NODE_DRAFT_PASS");
    `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 })
    expect(child.stdout).toContain("NODE_DRAFT_PASS")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
