import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "../src/util/windows-credential-store"

const native = test.skipIf(process.platform !== "win32")
// First-use PowerShell/.NET preparation can take nearly a minute on clean CI.
// This test budget does not change the production 15s read/publication bound.
const timeout = 90_000
const value = '{"fixture":"synthetic-only"}'
const readEntry = "    var file = Full(input);\n    using (var parent = PinParent(file, false))"
const unsafeAcl = `
  var acl = File.GetAccessControl(file);
  acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.Read, AccessControlType.Allow));
  File.SetAccessControl(file, acl);
`

async function fixture() {
  const parent = path.resolve(tmpdir())
  const root = await mkdtemp(path.join(parent, "bc-read-retry-"))
  const file = path.join(root, "private", "dummy.json")
  const store = windowsCredentialStore(file)
  store.prepareParent()
  store.publish(value)
  return {
    file,
    async close() {
      if (path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith("bc-read-retry-"))
        throw new Error("Unsafe fixture cleanup target")
      await rm(root, { recursive: true, force: true })
    },
  }
}

function tracked(file: string, alter: (script: string) => string) {
  const calls: { operation: string; reads: number; backoffs: number; writes: number; status: number | null }[] = []
  const store = windowsCredentialStore(file, {
    spawn: ((exe: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
      const script = args
        .at(-1)!
        .replace(
          readEntry,
          '    var file = Full(input);\n    Console.Error.WriteLine("TEST_READ");\n    using (var parent = PinParent(file, false))',
        )
        .replace(
          "System.Threading.Thread.Sleep(75);",
          'Console.Error.WriteLine("TEST_BACKOFF"); System.Threading.Thread.Sleep(75);',
        )
      const result = spawnSync(exe, [...args.slice(0, -1), alter(script)], options)
      calls.push({
        operation: JSON.parse(String(options!.input)).operation,
        reads: String(result.stderr).split("TEST_READ").length - 1,
        backoffs: String(result.stderr).split("TEST_BACKOFF").length - 1,
        writes: String(result.stderr).split("TEST_WRITE").length - 1,
        status: result.status,
      })
      return result
    }) as typeof spawnSync,
  })
  return { store, calls }
}

// Real kernel sharing conflict, not an injected exception: retain a WRITE
// handle before the first read. Release at the caught-conflict barrier, never
// after a guessed sleep. Production still executes every path/ACL check.
function heldWriter(script: string, release: boolean, unsafeAfterRelease = false) {
  return script
    .replace("  const uint READ_CONTROL", "  static FileStream TestWriter;\n  const uint READ_CONTROL")
    .replace(
      '    Console.Error.WriteLine("TEST_READ");',
      `
    Console.Error.WriteLine("TEST_READ");
    if (TestWriter == null) TestWriter = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
`,
    )
    .replace(
      "catch (SharingViolation) {",
      `catch (SharingViolation) {
      ${release ? "TestWriter.Dispose();" : ""}
      ${unsafeAfterRelease ? "var file = Full(input);" + unsafeAcl : ""}
`,
    )
}

native(
  "read retries a real sharing violation and succeeds after the writer releases",
  async () => {
    const f = await fixture()
    try {
      const probe = tracked(f.file, (script) => heldWriter(script, true))
      expect(probe.store.read()).toBe(value)
      expect(probe.calls).toEqual([{ operation: "read", reads: 2, backoffs: 1, writes: 0, status: 0 }])
    } finally {
      await f.close()
    }
  },
  timeout,
)

native(
  "read sharing exhaustion is four attempts with three bounded waits and a safe busy cause",
  async () => {
    const f = await fixture()
    try {
      const probe = tracked(f.file, (script) => heldWriter(script, false))
      let failure: unknown
      try {
        probe.store.read()
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe("Windows credential store is busy. Try again.")
      expect((failure as Error).cause).toBe("CREDENTIAL_STORE_BUSY")
      expect(probe.calls).toEqual([{ operation: "read", reads: 4, backoffs: 3, writes: 0, status: 32 }])
      expect(windowsCredentialStore(f.file).read()).toBe(value)
    } finally {
      await f.close()
    }
  },
  timeout,
)

native(
  "retry repeats ACL validation and stops immediately if the released file is unsafe",
  async () => {
    const f = await fixture()
    try {
      const probe = tracked(f.file, (script) => heldWriter(script, true, true))
      expect(() => probe.store.read()).toThrow("could not be verified")
      expect(probe.calls).toEqual([{ operation: "read", reads: 2, backoffs: 1, writes: 0, status: 1 }])
      expect(() => windowsCredentialStore(f.file).read()).toThrow("could not be verified")
    } finally {
      await f.close()
    }
  },
  timeout,
)

native(
  "unsafe ACL rejection is never retried",
  async () => {
    const f = await fixture()
    try {
      const probe = tracked(f.file, (script) =>
        script.replace(
          '    Console.Error.WriteLine("TEST_READ");',
          `Console.Error.WriteLine("TEST_READ"); ${unsafeAcl}`,
        ),
      )
      expect(() => probe.store.read()).toThrow("could not be verified")
      expect(probe.calls).toEqual([{ operation: "read", reads: 1, backoffs: 0, writes: 0, status: 1 }])
    } finally {
      await f.close()
    }
  },
  timeout,
)

for (const phase of ["before", "after"] as const) {
  native(
    `publication ${phase} activation never retries even a typed sharing failure`,
    async () => {
      const f = await fixture()
      try {
        const edge =
          phase === "before"
            ? "var file = Full(input);\n    var bytes = Convert.FromBase64String(content);"
            : "activated = true;"
        const probe = tracked(f.file, (script) =>
          script.replace(
            edge,
            `${edge} Console.Error.WriteLine("TEST_WRITE"); if (DateTime.UtcNow.Ticks > 0) throw new SharingViolation();`,
          ),
        )
        expect(() => probe.store.publish('{"fixture":"next"}')).toThrow("publication was not confirmed")
        expect(probe.calls).toEqual([{ operation: "publish", reads: 0, backoffs: 0, writes: 1, status: 1 }])
        expect(windowsCredentialStore(f.file).read()).toBe(phase === "before" ? value : '{"fixture":"next"}')
      } finally {
        await f.close()
      }
    },
    timeout,
  )
}

for (const operation of ["prepare", "quarantine-marker"] as const) {
  native(
    `${operation} never retries a typed sharing failure`,
    async () => {
      const f = await fixture()
      try {
        const edge =
          operation === "prepare"
            ? "public static void Prepare(string input) {"
            : "public static void QuarantineMarker(string input, string destination, string expectedIdentity) {"
        const marker = path.join(path.dirname(f.file), ".schema-version")
        const probe = tracked(operation === "prepare" ? f.file : marker, (script) =>
          script.replace(
            edge,
            `${edge} Console.Error.WriteLine("TEST_WRITE"); if (DateTime.UtcNow.Ticks > 0) throw new SharingViolation();`,
          ),
        )
        expect(() =>
          operation === "prepare"
            ? probe.store.prepareParent()
            : probe.store.quarantineMarker(marker + ".quarantine-test", "1"),
        ).toThrow()
        expect(probe.calls).toEqual([{ operation, reads: 0, backoffs: 0, writes: 1, status: 1 }])
      } finally {
        await f.close()
      }
    },
    timeout,
  )
}

native(
  "compile failure is rejected once, without read retries or compiler output in the error",
  async () => {
    const f = await fixture()
    try {
      const probe = tracked(f.file, (script) =>
        script.replace(
          "public static class BharatCodeCredentialFile",
          "SYNTHETIC_INVALID_CSHARP public static class BharatCodeCredentialFile",
        ),
      )
      let failure: unknown
      try {
        probe.store.read()
      } catch (error) {
        failure = error
      }
      expect((failure as Error).cause).toBe("CREDENTIAL_HELPER_REJECTED")
      expect((failure as Error).message).not.toContain("SYNTHETIC_INVALID")
      expect(probe.calls).toEqual([{ operation: "read", reads: 0, backoffs: 0, writes: 0, status: 1 }])
    } finally {
      await f.close()
    }
  },
  timeout,
)

for (const failure of ["start", "timeout"] as const) {
  native(
    `read helper ${failure} failure never starts another process or reports a busy store`,
    async () => {
      const f = await fixture()
      try {
        let calls = 0
        const store = windowsCredentialStore(f.file, {
          spawn: ((exe: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
            calls++
            return failure === "start"
              ? spawnSync(f.file + ".missing.exe", args, options)
              : spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "[Threading.Thread]::Sleep(2000)"], {
                  ...options,
                  timeout: 100,
                })
          }) as typeof spawnSync,
        })
        let error: unknown
        try {
          store.read()
        } catch (caught) {
          error = caught
        }
        expect((error as Error).cause).toBe(
          failure === "start" ? "CREDENTIAL_HELPER_START_FAILED" : "CREDENTIAL_HELPER_TIMEOUT",
        )
        expect((error as Error).message).toBe("Windows credential permissions or access could not be verified.")
        expect(calls).toBe(1)
      } finally {
        await f.close()
      }
    },
    timeout,
  )
}
