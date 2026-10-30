import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js"
import { createSupportExporter, supportExportAction } from "./support-export"
import { supportPrivacyCases } from "./test-fixtures/support-privacy"

async function contents(filename: string) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(filename))))
  try {
    const entries = await reader.getEntries()
    expect(entries.map((entry) => entry.filename)).toEqual(["support-bundle.json"])
    const entry = entries[0]
    if (entry.directory) throw new Error("Expected diagnostic document")
    return await entry.getData!(new TextWriter())
  } finally {
    await reader.close()
  }
}

test("the actual archive excludes #67/#68 adversarial log/config values and symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-adversarial-"))
  try {
    const privateFile = join(root, "private.txt")
    await writeFile(privateFile, "PRIVATE-FILE-CONTENT")
    await mkdir(join(root, "logs"))
    await symlink(privateFile, join(root, "logs", "link.log"))
    await writeFile(join(root, "logs", "main.log"), supportPrivacyCases.map(([input]) => input).join("\n"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        apiToken: "abcTOK",
        accessToken: "AT1",
        clientSecret: "CS1",
        refreshToken: "RT1",
        authorization: "Token my-secret-token",
        headers: { cookie: "sid=SS1", "x-api-key": "KK1", authorization: "Bearer secret_hdr" },
        env: { OPENAI_API_KEY: "envkey1", DB_PASSWORD: "pw1" },
        messages: [{ content: { parts: ["nested prompt"] } }],
      }),
    )
    for (const [input, secret] of supportPrivacyCases) {
      const run = createSupportExporter({
        directory: () => root,
        input: () => ({
          version: "1.2.3",
          channel: "beta",
          platform: "linux",
          // Poison accepted scalar fields as well as fields that must be omitted.
          release: input,
          arch: input,
          auth: { state: input, authenticated: true, authorization: input },
          config: { directory: input, override: input, sanitized: input },
          database: { schemaVersion: input, latestMigration: input, path: input, checks: [input] },
          errors: { network: input },
          rawLogs: input,
          content: { parts: [input] },
        }),
        reveal: () => {},
        failure: () => new Error("safe failure"),
      })
      const file = await run()
      const text = await contents(file)
      expect(text).not.toContain(secret)
      expect(text).not.toContain("PRIVATE-FILE-CONTENT")
      expect(text).not.toContain("my-secret-token")
      expect(text).not.toContain("nested prompt")
      expect(text).not.toContain(root)
      expect(JSON.parse(text)).toMatchObject({
        version: "1.2.3",
        channel: "beta",
        os: { platform: "linux" },
        auth: { state: "unknown", authenticated: false },
        database: { schemaVersion: null, latestMigration: null },
        errors: { counts: { network: 0 } },
      })
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("actual exported archive excludes private neighboring files and hostile metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-export-"))
  try {
    const secrets = [
      "sk-api-private-123",
      "oauth-access-private",
      "oauth-refresh-private",
      "owner@private.test",
      "raw private prompt",
      "https://github.com/private/repo",
      "eyJhbGciOiJIUzI1NiJ9.private.signature",
    ]
    for (const name of ["logs", "Crashpad", "config", "chats"]) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, "private.txt"), secrets.join("\n"))
    }
    const reveals: string[] = []
    const run = createSupportExporter({
      directory: () => root,
      input: () => ({
        version: "1.2.3",
        channel: "beta",
        platform: "linux",
        auth: { state: "signed_in", authenticated: true, email: secrets[3], token: secrets[0] },
        config: { directory: true, authStore: true },
        private: secrets,
      }),
      reveal: (file) => {
        reveals.push(file)
      },
      failure: () => new Error("safe failure"),
    })
    const file = await run()
    expect(file).toContain("bharatcode-support-")
    expect(reveals).toEqual([file])
    const text = await contents(file)
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(text).not.toContain(root)
    expect(JSON.parse(text)).toMatchObject({
      version: "1.2.3",
      channel: "beta",
      config: { directory: true, authStore: true },
      auth: { state: "signed_in", authenticated: true },
    })
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).some((file) => file.endsWith(".tmp"))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("coalesces concurrent requests and still saves when metadata or reveal fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-export-"))
  try {
    const ready = Promise.withResolvers<Record<string, unknown>>()
    const run = createSupportExporter({
      directory: () => root,
      input: () => ready.promise,
      reveal: () => {
        throw new Error("private reveal error")
      },
      failure: () => new Error("safe failure"),
    })
    const one = run()
    expect(run()).toBe(one)
    ready.reject(new Error("private metadata error"))
    const file = await one
    expect(JSON.parse(await contents(file)).auth.state).toBe("unknown")
    expect(await run()).not.toBe(file)
    expect(await readdir(root)).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("write failure has safe error, no partial file, and allows retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-export-"))
  try {
    let target = join(root, "missing")
    const run = createSupportExporter({
      directory: () => target,
      input: () => ({}),
      reveal: () => {},
      failure: () => new Error("safe failure"),
    })
    await expect(run()).rejects.toThrow("safe failure")
    expect(await readdir(root)).toEqual([])
    target = root
    expect(await contents(await run())).toContain('"formatVersion": 1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("IPC checks owned main-frame before requesting any export and hides action failures", async () => {
  let calls = 0
  const mainFrame = {}
  const action = supportExportAction({
    owned: (id) => id === 1,
    run: async () => {
      calls++
      throw new Error("private/path/token")
    },
    failure: () => new Error("safe failure"),
  })
  for (const event of [
    { sender: { id: 2, mainFrame }, senderFrame: mainFrame },
    { sender: { id: 1, mainFrame }, senderFrame: {} },
  ]) {
    await expect(action(event)).rejects.toThrow("safe failure")
  }
  expect(calls).toBe(0)
  await expect(action({ sender: { id: 1, mainFrame }, senderFrame: mainFrame })).rejects.toThrow("safe failure")
  expect(calls).toBe(1)
})

test("the production logging export uses real metadata and the same safe archive before runtime initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "bc-support-production-"))
  try {
    // Bun 1.3.14 caches workspace subpath resolutions incorrectly across builds
    // with different plugins. Keep this Electron-boundary build in a fresh process.
    const { spawnSync } = await import("node:child_process")
    const build = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const result = await Bun.build({
        entrypoints: [${JSON.stringify(fileURLToPath(new URL("./logging.ts", import.meta.url)))}],
        outdir: ${JSON.stringify(root)}, target: 'node', format: 'esm', naming: 'logging.mjs',
        define: { 'import.meta.env.OPENCODE_CHANNEL': '"beta"' },
        plugins: [{ name: 'electron-fixture', setup(builder) {
          builder.onResolve({ filter: /^(electron|electron-log)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
          builder.onResolve({ filter: /^electron-log\\/main\\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
            ? "export const app = { getPath: () => process.env.BC_SUPPORT_HOME, getVersion: () => '1.2.3' }; export const shell = { showItemInFolder: () => {} }; export const netLog = {}; export const crashReporter = {};"
            : "export default {};", loader: 'js' }));
        }}],
      });
      if (!result.success) { console.error(result.logs); process.exit(1); }
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    )
    expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: "" })
    await writeFile(join(root, "network.netlog"), "oauth-secret-private")
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      const {exportDebugLogs, setSupportAuthReader} = await import(${JSON.stringify(pathToFileURL(join(root, "logging.mjs")).href)});
      console.log(await exportDebugLogs());
      setSupportAuthReader(() => ({state: 'signed_in', authenticated: true, email: 'owner@private.test', token: 'oauth-secret-private'}));
      console.log(await exportDebugLogs());
    `,
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          BC_SUPPORT_HOME: root,
          XDG_DATA_HOME: join(root, "data"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state"),
        },
      },
    )
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 })
    const files = child.stdout.trim().split("\n")
    expect(files).toHaveLength(2)
    for (const file of files) {
      const text = await contents(file)
      expect(text).not.toContain("owner@private.test")
      expect(text).not.toContain("oauth-secret-private")
      expect(text).not.toContain(root)
      expect(JSON.parse(text)).toMatchObject({
        version: "1.2.3",
        channel: "beta",
        database: { availability: "missing" },
        config: { directory: false },
      })
    }
    expect(JSON.parse(await contents(files[0])).auth.state).toBe("unknown")
    expect(JSON.parse(await contents(files[1])).auth.state).toBe("signed_in")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
