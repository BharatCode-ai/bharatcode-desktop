import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Electron uses Node SQLite; Bun 1.3.14 does not implement node:sqlite.
// Exercise the real store in Node rather than mocking its database binding.
test("Node draft storage flushes buffered edits and preserves referenced blobs over reopen", async () => {
  const parent = await realpath(tmpdir())
  const home = await mkdtemp(join(parent, "bharatcode-draft-test-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("./draft-store.ts"))],
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
      const { createDesktopDraftStore } = await import(${JSON.stringify(pathToFileURL(join(home, "draft-store.mjs")).href)});
      const memory = createDesktopDraftStore(":memory:");
      memory.set("prompt", "first");
      memory.set("prompt", "latest");
      assert.equal(memory.get("prompt"), "latest");
      memory.flush();
      assert.equal(memory.get("prompt"), "latest");
      const bytes = Buffer.from("synthetic attachment");
      const memoryID = memory.putBlob(bytes);
      assert.deepEqual(Buffer.from(memory.getBlob(memoryID)), bytes);
      memory.close();

      const path = ${JSON.stringify(join(home, "drafts.sqlite"))};
      const first = createDesktopDraftStore(path);
      const id = first.putBlob(bytes);
      const unusedID = first.putBlob(Buffer.from("unreferenced fixture"));
      const draft = JSON.stringify({ text: "latest", attachment: { blob: { id } } });
      first.set("prompt", JSON.stringify({ text: "first" }));
      first.set("prompt", draft);
      first.close();
      const reopened = createDesktopDraftStore(path);
      assert.equal(reopened.get("prompt"), draft);
      assert.deepEqual(Buffer.from(reopened.getBlob(id)), bytes);
      assert.equal(reopened.getBlob(unusedID), null);
      reopened.set("prompt", null);
      assert.equal(reopened.get("prompt"), null);
      reopened.close();
      const removed = createDesktopDraftStore(path);
      assert.equal(removed.get("prompt"), null);
      assert.equal(removed.getBlob(id), null);
      removed.close();
      console.log("NODE_DRAFT_PASS");
    `,
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
          OPENCODE_TEST_HOME: home,
          TMP: home,
          TEMP: home,
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    )
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 })
    expect(child.stdout).toContain("NODE_DRAFT_PASS")
  } finally {
    const actual = await realpath(home)
    if (dirname(actual) !== parent) throw new Error("Draft fixture cleanup scope mismatch")
    await rm(actual, { recursive: true, force: true })
  }
}, 15_000)
