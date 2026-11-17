import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { StoragePaths } from "../../../core/src/storage-paths"
import { windowsCredentialStore } from "../../../core/src/util/windows-credential-store"
import { configureDesktopProfile } from "./branding"
import schema from "@opencode-ai/core/database/schema.gen"
import { SETTINGS_STORE } from "./store-keys"

// Frozen beta paths, not calculated by the resolver under test. Map logical
// paths into a private fixture so all three layouts run on every test host.
const layouts = {
  win32: ["AppData/Roaming", "AppData/Local/BharatCode Beta/Data", "AppData/Roaming/BharatCode Beta/Config"],
  darwin: [
    "Library/Application Support",
    "Library/Application Support/BharatCode Beta",
    "Library/Preferences/BharatCode Beta",
  ],
  linux: [".config", ".local/share/BharatCode Beta", ".config/BharatCode Beta"],
} as const

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`${platform}: stable reopens the shipped profile without merging an unrelated prod profile`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-upgrade-"))
    try {
      const paths = platform === "win32" ? path.win32 : path.posix
      const home = platform === "win32" ? "C:\\Users\\Fixture" : "/home/fixture"
      const local = (file: string) => {
        const relative = paths.relative(home, file)
        if (relative.startsWith("..") || paths.isAbsolute(relative)) throw new Error("Fixture path escaped")
        return path.join(root, ...relative.split(paths.sep))
      }
      const [appData, data, config] = layouts[platform].map((dir) => path.join(root, dir))
      const desktop = path.join(appData!, "ai.bharatcode.desktop.beta")
      for (const dir of [desktop, data!, config!]) await mkdir(dir, { recursive: true, mode: 0o700 })
      const settings = {
        firstLaunchOnboardingComplete: true,
        windowIds: ["old-window"],
        defaultServerUrl: "wsl:Ubuntu",
      }
      const auth = {
        bharatcode: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 4102444800000 },
      }
      await writeFile(path.join(desktop, "bharatcode.settings"), JSON.stringify(settings))
      await writeFile(path.join(desktop, "opencode.global.dat"), '{"language":"{\\"locale\\":\\"hi\\"}"}')
      await writeFile(path.join(config!, "opencode.json"), '{"theme":"dark"}')
      await writeFile(path.join(data!, "auth.json"), JSON.stringify(auth), { mode: 0o600 })

      const old = new Database(path.join(data!, "bharatcode.db"), { create: true })
      try {
        const tx = { run: (sql: string) => Effect.sync(() => old.exec(sql)) }
        await Effect.runPromise(schema.up(tx as unknown as Parameters<typeof schema.up>[0]))
        old.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
        old.exec(`
          INSERT INTO project(id,worktree,time_created,time_updated,sandboxes)
            VALUES ('prj_fixture','checkout',1,1,'[]');
          INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated)
            VALUES ('ses_fixture','prj_fixture','fixture','checkout','Unfinished work','1.15.46',1,1);
          INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
            VALUES ('msg_fixture','ses_fixture','user',1,1,1,'{"text":"resume me"}');
        `)
        const input = { platform, home, temp: home, channel: "prod" }
        const independent = local(StoragePaths.resolve(input).auth)
        await mkdir(path.dirname(independent), { recursive: true })
        await writeFile(independent, "standalone-cli-sentinel")
        for (const channel of ["prod", "latest"]) {
          const runtime = StoragePaths.resolve({ ...input, channel, env: { OPENCODE_CLIENT: "desktop" } })
          expect(runtime.channel).toBe("prod")
          expect(JSON.parse(await readFile(local(runtime.auth), "utf8"))).toEqual(auth)
          expect(JSON.parse(await readFile(path.join(local(runtime.config), "opencode.json"), "utf8"))).toEqual({
            theme: "dark",
          })
          const upgraded = new Database(local(runtime.database), { readonly: true })
          try {
            expect(
              upgraded
                .query(
                  `
              SELECT worktree,title,data FROM session_message
              JOIN session ON session.id=session_message.session_id JOIN project ON project.id=session.project_id
            `,
                )
                .all(),
            ).toEqual([{ worktree: "checkout", title: "Unfinished work", data: '{"text":"resume me"}' }])
          } finally {
            upgraded.close()
          }
        }
        let userData = ""
        configureDesktopProfile(
          {
            getPath: (key) => {
              expect(key).toBe("appData")
              return appData!
            },
            setPath: (key, value) => {
              expect(key).toBe("userData")
              userData = value
            },
            setName: (name) => expect(name).toBe("BharatCode Beta"),
            setAppUserModelId: (id) => expect(id).toBe("ai.bharatcode.desktop.beta"),
            setAboutPanelOptions: (options) => expect(options.applicationName).toBe("BharatCode"),
          },
          "prod",
        )
        expect(JSON.parse(await readFile(path.join(userData, SETTINGS_STORE), "utf8"))).toEqual(settings)
        expect(JSON.parse(await readFile(path.join(userData, "opencode.global.dat"), "utf8")).language).toBe(
          '{"locale":"hi"}',
        )
        expect(await readFile(independent, "utf8")).toBe("standalone-cli-sentinel")
      } finally {
        old.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test.skipIf(process.platform !== "win32")(
  "stable reads beta auth through the Windows ACL adapter",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bc-upgrade-acl-"))
    try {
      const local = path.join(home, "AppData", "Local")
      await mkdir(local, { recursive: true })
      const original = windowsCredentialStore(path.join(local, "BharatCode Beta", "Data", "auth.json"))
      original.prepareParent()
      const synthetic = JSON.stringify({
        bharatcode: { type: "oauth", access: "fixture", refresh: "fixture", expires: 4102444800000 },
      })
      original.publish(synthetic)
      const stable = StoragePaths.resolve({
        platform: "win32",
        channel: "prod",
        home,
        temp: home,
        env: { LOCALAPPDATA: local, OPENCODE_CLIENT: "desktop" },
      })
      expect(windowsCredentialStore(stable.auth).read()).toBe(synthetic)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
  120_000,
)
