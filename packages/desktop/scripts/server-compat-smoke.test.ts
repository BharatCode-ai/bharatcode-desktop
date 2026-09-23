import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

test("renderer SDK adapters preserve project and session identity across compiled Node restarts", async () => {
  const home = await mkdtemp(join(tmpdir(), "bharatcode-sdk-smoke-"))
  try {
    const build = await Bun.build({
      entrypoints: ["../app/test-runtime/server-compat.ts"],
      outdir: home,
      target: "node",
      format: "esm",
      naming: "client-compat.mjs",
      tsconfig: "../app/tsconfig.json",
    })
    expect(build.success).toBe(true)
    const server = pathToFileURL(resolve("../opencode/dist/node/node.js")).href
    const client = pathToFileURL(join(home, "client-compat.mjs")).href
    const pty = import.meta.resolve(`@lydell/node-pty-${process.platform}-${process.arch}`)
    for (const mode of ["create", "reopen"]) {
      const child = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        import { mkdir, writeFile, readFile } from "node:fs/promises";
        import { execFileSync } from "node:child_process";
        import path from "node:path";
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === "@lydell/node-pty") return { url: ${JSON.stringify(pty)}, shortCircuit: true };
          return next(specifier, context);
        }});
        const network = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.hostname !== "127.0.0.1") throw Error("External network prohibited in SDK fixture");
          return network(input, init);
        };
        const { Server } = await import(${JSON.stringify(server)});
        const { verify } = await import(${JSON.stringify(client)});
        const directory = path.join(process.env.HOME, "project");
        const receipt = path.join(process.env.HOME, "session.json");
        if (${JSON.stringify(mode)} === "create") {
          await mkdir(directory);
          await writeFile(path.join(directory, "README.md"), "synthetic fixture");
          execFileSync("git", ["init", "--quiet", directory]);
        }
        const saved = ${JSON.stringify(mode)} === "reopen" ? JSON.parse(await readFile(receipt, "utf8")) : {};
        const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 });
        try {
          const result = await verify({ url: listener.url.toString(), directory, ...saved });
          if (${JSON.stringify(mode)} === "create") await writeFile(receipt, JSON.stringify(result));
          console.log("SDK_COMPAT_PASS");
        } finally { await listener.stop(true); }
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
      expect({ mode, status: child.status, stderr: child.stderr.slice(-4000) }).toMatchObject({ status: 0 })
      expect(child.stdout).toContain("SDK_COMPAT_PASS")
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 100_000)
