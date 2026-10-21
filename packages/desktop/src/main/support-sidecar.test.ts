import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("sidecar startup sends only projected database metadata through the private ready message", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-sidecar-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./sidecar.ts", import.meta.url))],
      outdir: root,
      target: "node",
      format: "esm",
      naming: "sidecar.mjs",
      plugins: [
        {
          name: "runtime-fixture",
          setup(builder) {
            builder.onResolve({ filter: /^virtual:opencode-server$/ }, () => ({
              path: "runtime",
              namespace: "fixture",
            }))
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: `
          export const Server = { async listen(options) {
            options.onSupportDatabase({ availability: 'available', source: 'runtime_snapshot', capturedAt: '2026-10-21T12:00:00.000Z', schemaVersion: 42, migrationFormat: 'current', appliedCount: 5, latestMigration: 20261021000000, email: 'owner@private.test', token: 'sk-private', rows: ['private prompt'] });
            return { stop: async () => {} };
          }};
        `,
              loader: "js",
            }))
          },
        },
      ],
    })
    expect(build.success).toBe(true)
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      let dispatch;
      const ready = Promise.withResolvers();
      process.parentPort = { on(_name, callback) { dispatch = callback }, postMessage(message) { if (message.type === 'ready') ready.resolve(message); if (message.type === 'error') ready.reject(new Error(message.error.message)); } };
      await import(${JSON.stringify(pathToFileURL(join(root, "sidecar.mjs")).href)});
      dispatch({ data: { type: 'start', hostname: '127.0.0.1', port: 0, password: 'synthetic-only', userDataPath: ${JSON.stringify(root)} } });
      const message = await ready.promise;
      assert.equal(message.databaseMetadata.source, 'runtime_snapshot');
      assert.equal(message.databaseMetadata.schemaVersion, 42);
      assert.equal(message.databaseMetadata.appliedCount, 5);
      assert(!JSON.stringify(message).includes('private'));
      console.log('PRIVATE_READY_PASS');
      dispatch({data:{type:'stop'}});
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    )
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 })
    expect(child.stdout).toContain("PRIVATE_READY_PASS")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
