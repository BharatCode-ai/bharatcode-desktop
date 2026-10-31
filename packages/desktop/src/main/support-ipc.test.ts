import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

test("registered production export IPC rejects foreign/subframe calls and uses the canonical exporter", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-ipc-"))
  try {
    await writeFile(
      join(root, "entry.ts"),
      `
      export {registerIpcHandlers} from ${JSON.stringify(fileURLToPath(new URL("./ipc.ts", import.meta.url)))};
      export {handlers} from 'fixture-state';
    `,
    )
    // Stub Electron and unrelated native boundaries, keeping the production
    // registration function and its real supportExportAction in the test.
    const build = await Bun.build({
      entrypoints: [join(root, "entry.ts")],
      outdir: root,
      target: "node",
      format: "esm",
      naming: "ipc.mjs",
      plugins: [
        {
          name: "ipc-boundaries",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (
                args.path === "fixture-state" ||
                args.path === "@zip.js/zip.js" ||
                (args.importer.replace(/\\/g, "/").endsWith("/ipc.ts") &&
                  !args.path.startsWith("node:") &&
                  args.path !== "./support-export")
              )
                return { path: "boundaries", namespace: "fixture" }
              return undefined
            })
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "js",
              contents: `
          export const handlers = new Map();
          export const ipcMain = {handle: (name, handler) => {if(handlers.has(name)) throw Error('duplicate route'); handlers.set(name, handler)}, on: () => {}};
          export const app = {getPath: () => ${JSON.stringify(root)}, once: () => {}, on: () => {}};
          export const BrowserWindow = {}, clipboard = {}, dialog = {}, shell = {};
          export const isOwnedRenderer = id => id === 1;
          export const nativeT = key => key;
          export const createPickedFileAuthorizations = () => ({});
          export const createDesktopDraftStore = () => ({});
          export const createUpdaterSubscriptions = () => new Map();
          export const parseDesktopNativeBundle = () => undefined;
          export const runDesktopMenuAction = () => {}, setForceFocus = () => {}, assertAttachmentBudget = () => {};
          export const getStore = () => {}, removeStoreFileIfEmpty = () => {};
          export const getPinchZoomEnabled = () => {}, getWindowID = () => {}, openExternalURL = () => {}, openLocalFileURL = () => {};
          export const setPinchZoomEnabled = () => {}, setTitlebar = () => {}, updateTitlebar = () => {}, getChatImportStatus = () => {};
          export const ZipWriter = class {}, Uint8ArrayWriter = class {}, TextReader = class {};
        `,
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
      const {registerIpcHandlers,handlers} = await import(${JSON.stringify(pathToFileURL(join(root, "ipc.mjs")).href)});
      let calls = 0;
      registerIpcHandlers({exportDebugLogs: async () => {calls++; return 'canonical.zip'}});
      const action = handlers.get('export-debug-logs');
      assert.equal(typeof action, 'function');
      const mainFrame = {};
      for(const event of [
        {sender: {id:2,mainFrame},senderFrame:mainFrame},
        {sender: {id:1,mainFrame},senderFrame:{}},
      ]) await assert.rejects(action(event), /desktop.support.error.export/);
      assert.equal(calls,0);
      assert.equal(await action({sender:{id:1,mainFrame},senderFrame:mainFrame}), 'canonical.zip');
      assert.equal(calls,1);
      // #59 deliberately retains one existing route; there is no competing exporter.
      assert.equal(handlers.has('export-support-bundle'),false);
      console.log('registered support IPC passed');
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    )
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" })
    expect(child.stdout).toContain("registered support IPC passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
