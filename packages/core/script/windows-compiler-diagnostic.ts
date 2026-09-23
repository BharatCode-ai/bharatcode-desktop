// Temporary, synthetic-only hosted diagnostic. Remove once compiler latency is explained.
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { windowsCredentialStore } from "../src/util/windows-credential-store"

if (process.platform !== "win32") throw new Error("Native Windows diagnostic only")
const root = process.env.SystemRoot!
const home = await mkdtemp(path.join(os.tmpdir(), "bc-compiler-probe-"))
const env = { SystemRoot: root, WINDIR: root, TEMP: home, TMP: home }
const powershell = path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe")
const csc = path.join(root, "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
let source = ""
windowsCredentialStore(path.join(home, "unused", "auth.json"), {
  spawn: ((_command, args, _options) => {
    source = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(args!.at(-1)!)?.[1] ?? ""
    return { status: 0, stdout: '{"ok":true,"content":null}', stderr: "" }
  }) as typeof spawnSync,
}).prepareParent()
if (!source) throw new Error("Could not capture the checked-in helper source")

function probe(name: string, command: string, args: string[]) {
  const start = performance.now()
  const result = spawnSync(command, args, { env, cwd: home, windowsHide: true, timeout: 90_000, encoding: "utf8" })
  console.log(
    JSON.stringify({
      name,
      elapsedMs: Math.round(performance.now() - start),
      status: result.status,
      outcome:
        result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
          ? "TIMEOUT"
          : result.status === 0
            ? "PASS"
            : "FAIL",
    }),
  )
}

try {
  const prefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
  const tiny = "public static class BharatCodeCompilerProbe { public static int Value() { return 1; } }"
  probe("host-only", powershell, [...prefix, "[Console]::Out.Write('ok')"])
  probe("tiny-add-type", powershell, [...prefix, `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition '${tiny}'`])
  probe("actual-add-type", powershell, [
    ...prefix,
    `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@`,
  ])
  probe("compiler-help", csc, ["/nologo", "/help"])
  for (const [name, code] of [
    ["tiny", tiny],
    ["actual", source],
  ]) {
    await Bun.write(path.join(home, `${name}.cs`), code)
    probe(`${name}-direct-compiler`, csc, [
      "/nologo",
      "/target:library",
      `/out:${path.join(home, `${name}.dll`)}`,
      path.join(home, `${name}.cs`),
    ])
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
