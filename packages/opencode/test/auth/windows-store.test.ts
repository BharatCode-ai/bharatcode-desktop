import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, link, symlink, mkdir, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "../../src/auth/windows-store"

test.skipIf(process.platform !== "win32")(
  "native held Windows credential store reads missing, publishes, rotates and removes",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-native-auth-"))
    const file = path.join(root, "private", "auth.json")
    const store = windowsCredentialStore(file)
    try {
      expect(store.read()).toBeUndefined()
      store.publish('{"bharatcode":{"type":"api","key":"synthetic-first"}}')
      expect(JSON.parse(store.read()!).bharatcode.key).toBe("synthetic-first")
      store.publish('{"bharatcode":{"type":"api","key":"synthetic-next"}}')
      expect(JSON.parse(store.read()!).bharatcode.key).toBe("synthetic-next")
      store.publish("{}")
      expect(store.read()).toBe("{}")
      expect(await readFile(file, "utf8")).toBe("{}")
      expect(await readdir(path.dirname(file))).toEqual(["auth.json"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

const native = test.skipIf(process.platform !== "win32")
function injected(file: string, before: string, after: string) {
  return windowsCredentialStore(file, {
    spawn: ((exe: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
      expect(args.at(-1)).toContain(before)
      return spawnSync(exe, [...args.slice(0, -1), args.at(-1)!.replace(before, after)], options)
    }) as typeof spawnSync,
  })
}

for (const target of ["file", "parent"])
  for (const sid of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11"]) {
    native(
      `actual native ACL rejects effective access for ${sid} on credential ${target}`,
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), "bc-native-acl-"))
        const file = path.join(root, "private", "auth.json")
        try {
          windowsCredentialStore(file).publish('{"synthetic":"preserve"}')
          const script = `$ErrorActionPreference='Stop'; $p=$env:BC_TEST_FILE; $acl=[Security.AccessControl.${target === "file" ? "File" : "Directory"}Security]::new($p,[Security.AccessControl.AccessControlSections]::Access); $sid=[Security.Principal.SecurityIdentifier]::new('${sid}'); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')); [IO.${target === "file" ? "File" : "Directory"}]::SetAccessControl($p,$acl)`
          const result = spawnSync(
            path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-Command", script],
            {
              env: {
                SystemRoot: process.env.SystemRoot,
                WINDIR: process.env.SystemRoot,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
                BC_TEST_FILE: target === "file" ? file : path.dirname(file),
              },
              windowsHide: true,
            },
          )
          if (result.status !== 0) throw new Error(result.stderr.toString())
          expect(() => windowsCredentialStore(file).read()).toThrow("could not be verified")
          expect(() => windowsCredentialStore(file).publish("{}")).toThrow("not confirmed")
          expect(await readFile(file, "utf8")).toBe('{"synthetic":"preserve"}')
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      60_000,
    )
  }

native(
  "inherited broad existing parent is not hardened: definite missing is signed out, publication and existing read fail",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-native-default-acl-"))
    try {
      const file = path.join(root, "data", "auth.json")
      const result = spawnSync(
        path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $p=$env:BC_TEST_ROOT; $acl=[IO.Directory]::GetAccessControl($p); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','ContainerInherit,ObjectInherit','None','Allow')); [IO.Directory]::SetAccessControl($p,$acl)",
        ],
        {
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, BC_TEST_ROOT: root },
          windowsHide: true,
        },
      )
      expect(result.status).toBe(0)
      await mkdir(path.dirname(file))
      const acl = () =>
        spawnSync(
          path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-Command", "[IO.Directory]::GetAccessControl($env:BC_TEST_ROOT).Sddl"],
          {
            env: {
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.SystemRoot,
              BC_TEST_ROOT: path.dirname(file),
            },
            windowsHide: true,
            encoding: "utf8",
          },
        ).stdout
      const before = acl()
      expect(before.length).toBeGreaterThan(0)
      windowsCredentialStore(file).prepareParent()
      expect(acl()).toBe(before)
      expect(windowsCredentialStore(file).read()).toBeUndefined()
      expect(() => windowsCredentialStore(file).publish("{}")).toThrow("not confirmed")
      await writeFile(file, "{}")
      expect(() => windowsCredentialStore(file).read()).toThrow("could not be verified")
      expect(acl()).toBe(before)
      expect(await readFile(file, "utf8")).toBe("{}")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

native(
  "permission-denied existing credentials and reparse ancestry never become signed out",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-native-denied-"))
    const file = path.join(root, "private", "auth.json")
    try {
      windowsCredentialStore(file).publish("{}")
      const result = spawnSync(
        path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $p=$env:BC_TEST_FILE; $acl=[IO.File]::GetAccessControl($p); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'ReadData','Deny')); [IO.File]::SetAccessControl($p,$acl)",
        ],
        {
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, BC_TEST_FILE: file },
          windowsHide: true,
        },
      )
      expect(result.status).toBe(0)
      expect(() => windowsCredentialStore(file).read()).toThrow("could not be verified")
      await rm(file)
      await symlink(path.dirname(file), path.join(root, "junction"), "junction")
      expect(() => windowsCredentialStore(path.join(root, "junction", "auth.json")).prepareParent()).toThrow(
        "could not be verified",
      )
      expect(() => windowsCredentialStore(path.join(root, "junction", "auth.json")).read()).toThrow(
        "could not be verified",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

native(
  "native held read rejects hardlinks and reparse parents without reading their bytes",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-native-links-"))
    const file = path.join(root, "private", "auth.json")
    try {
      const store = windowsCredentialStore(file)
      store.publish('{"synthetic":"private"}')
      await link(file, path.join(root, "second-link"))
      expect(() => store.read()).toThrow("could not be verified")
      await rm(path.join(root, "second-link"))
      await symlink(path.dirname(file), path.join(root, "junction"), "junction")
      expect(() => windowsCredentialStore(path.join(root, "junction", "auth.json")).read()).toThrow(
        "could not be verified",
      )
      expect(store.read()).toBe('{"synthetic":"private"}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

for (const target of ["file", "parent"]) {
  native(
    `held Windows ${target} cannot be replaced between ACL verification and consumption`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "bc-native-pinned-"))
      const file = path.join(root, "private", "auth.json")
      try {
        windowsCredentialStore(file).publish('{"synthetic":"held"}')
        const attempt =
          target === "file"
            ? 'File.Move(file, file + ".moved");'
            : 'Directory.Move(Path.GetDirectoryName(file), Path.GetDirectoryName(file) + ".moved");'
        const store = injected(file, "var security = Security(handle);", `var security = Security(handle); ${attempt}`)
        expect(() => store.read()).toThrow("could not be verified")
        expect(windowsCredentialStore(file).read()).toBe('{"synthetic":"held"}')
        expect(await readdir(root)).toEqual(["private"])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
}

native(
  "missing result never performs a second unverified read when the file appears",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-native-missing-"))
    const file = path.join(root, "private", "auth.json")
    try {
      const store = windowsCredentialStore(file)
      store.publish("{}")
      await rm(file)
      const raced = injected(
        file,
        "if (missing) return null;",
        'if (missing) { File.WriteAllText(file, "{}"); return null; }',
      )
      expect(raced.read()).toBeUndefined()
      expect(store.read()).toBe("{}")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

for (const phase of ["before", "after"]) {
  native(
    `native ${phase}-activation failure preserves truthful durable publication state`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "bc-native-publish-"))
      const file = path.join(root, "private", "auth.json")
      try {
        const store = windowsCredentialStore(file)
        store.publish('{"generation":1}')
        const edge =
          phase === "before" ? "RenameRelative(handle, parent.Parent, Path.GetFileName(file));" : "activated = true;"
        const altered =
          phase === "before"
            ? `if (DateTime.UtcNow.Ticks > 0) throw new IOException("Injected pre-publication fault"); ${edge}`
            : `${edge} if (DateTime.UtcNow.Ticks > 0) throw new IOException("Injected post-publication fault");`
        expect(() => injected(file, edge, altered).publish('{"generation":2}')).toThrow("not confirmed")
        expect(store.read()).toBe(phase === "before" ? '{"generation":1}' : '{"generation":2}')
        expect(await readdir(path.dirname(file))).toEqual(["auth.json"])
        // Subsequent callers observe the current generation rather than blindly replaying the old callback.
        store.publish('{"generation":3}')
        expect(store.read()).toBe('{"generation":3}')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
}

native(
  "a verifier process timeout is fail-closed and value-safe",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-native-timeout-"))
    try {
      const store = windowsCredentialStore(path.join(root, "private", "auth.json"), {
        spawn: ((exe: string, _args: string[], options: Parameters<typeof spawnSync>[2]) =>
          spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"], {
            ...options,
            timeout: 100,
            encoding: "utf8",
          })) as typeof spawnSync,
      })
      expect(() => store.read()).toThrow("could not be verified")
      expect(() => store.publish('{"synthetic-secret":"not-printed"}')).toThrow("Re-read account state")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(process.platform !== "win32" || !process.env.BHARATCODE_TEST_NATIVE_AUTH_EXE)(
  "compiled shared Auth service persists creation, rotation and logout across fresh processes",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bc-compiled-auth-"))
    try {
      for (const [action, generation] of [
        ["read", 0],
        ["create", 1],
        ["read", 1],
        ["rotate", 2],
        ["read", 2],
        ["remove", 0],
        ["read", 0],
      ] as const) {
        const result = spawnSync(process.env.BHARATCODE_TEST_NATIVE_AUTH_EXE!, [], {
          cwd: root,
          input: JSON.stringify({ root, action }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        })
        if (result.status !== 0) throw new Error(result.stderr)
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ generation })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
