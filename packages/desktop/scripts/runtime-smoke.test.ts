import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

test("sidecar serves protected signed-out state without reading legacy migration artifacts", async () => {
  const home = await mkdtemp(join(tmpdir(), "bharatcode-node-smoke-"))
  const moduleUrl = pathToFileURL(resolve("../opencode/dist/node/node.js")).href
  // Match electron.vite.config's native PTY external resolution; the intermediate
  // Node bundle is emitted under opencode, while Desktop owns these dependencies.
  const pty = import.meta.resolve(`@lydell/node-pty-${process.platform}-${process.arch}`)
  try {
    const sidecar = join(home, "sidecar.mjs")
    const build = await Bun.build({
      entrypoints: [resolve("src/main/sidecar.ts")],
      target: "node",
      format: "esm",
      external: ["virtual:opencode-server"],
    })
    expect(build.success).toBe(true)
    await Bun.write(sidecar, build.outputs[0])
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
        if (specifier === "virtual:opencode-server") return {url:${JSON.stringify(moduleUrl)},shortCircuit:true};
        return next(specifier,context);
      }});
      const network = globalThis.fetch;
      let externalRequests = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname !== "127.0.0.1") {
          externalRequests += 1;
          throw Error("External network prohibited in compiled fixture");
        }
        return network(input, init);
      };
      const userData = path.join(process.env.HOME,"electron");
      await mkdir(userData,{mode:0o700});
      const source = path.join(userData,"bharatcode.capabilities");
      const old = "malformed old marketplace settings: must not be read";
      await writeFile(source,old,{mode:0o600});
      const tauri = path.join(userData,"opencode.settings.dat");
      await writeFile(tauri,"malformed old Tauri settings");
      let dispatch;
      const ready = new Promise((resolve,reject) => {
        process.parentPort = {
          on(_event, callback) { dispatch = callback; },
          postMessage(message) {
            if (message.type === "ready") resolve();
            if (message.type === "error") reject(new Error(message.error.message));
          }
        };
      });
      await import(${JSON.stringify(pathToFileURL(sidecar).href)});
      dispatch({data:{type:"start",hostname:"127.0.0.1",port:0,password:"synthetic-smoke-only",userDataPath:userData}});
      await ready;
      const { Server } = await import(${JSON.stringify(moduleUrl)});
      const server = {url:Server.url};
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
        assert.equal(snapshot.state.installed["superpowers-obra"].enabled,true);
        assert.equal(snapshot.state.installed.github,undefined);
        assert.equal(snapshot.state.legacy,undefined);
        assert.equal(await readFile(source,"utf8"),old);
        assert.equal(await readFile(tauri,"utf8"),"malformed old Tauri settings");
        const headers = {authorization:"Basic "+Buffer.from("opencode:synthetic-smoke-only").toString("base64"),"content-type":"application/json"};
        const created = await fetch(new URL("/session",server.url),{method:"POST",headers,body:JSON.stringify({title:"Private sharing fixture"})});
        assert.equal(created.status,200);
        const session = await created.json();
        for (const method of ["POST","DELETE"]) {
          const blocked = await fetch(new URL("/session/"+session.id+"/share",server.url),{method,headers});
          assert.equal(blocked.status,500);
        }
        const unshared = await fetch(new URL("/session/"+session.id,server.url),{headers});
        assert.equal((await unshared.json()).share,undefined);
        assert.equal(externalRequests,0);
        console.log("COMPILED_ACCOUNT_PASS");
      } finally { dispatch({data:{type:"stop"}}); }
      process.exit(0);
    `,
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, "roaming"),
          LOCALAPPDATA: join(home, "local"),
          TEMP: home,
          TMP: home,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
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
