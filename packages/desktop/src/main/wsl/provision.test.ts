import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, link, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { provisionWslRuntime, resolveWslIdentity, type WslExecute } from "./provision"

test("resolves non-root WSL identity and rejects root, changed identity and malformed data", async () => {
  const execute: WslExecute = async (_distro, args) =>
    args[1] === "-u" ? "1000\n" : args[1] === "-un" ? "tester\n" : "tester:x:1000:1000:Test:/home/tester:/bin/bash\n"
  expect(await resolveWslIdentity(execute, "Ubuntu 22.04")).toEqual({ user: "tester", uid: 1000, home: "/home/tester" })
  await expect(resolveWslIdentity(async () => "0\n", "Ubuntu")).rejects.toThrow("non-root")
  await expect(resolveWslIdentity(execute, "Ubuntu;touch /tmp/no")).rejects.toThrow("distribution")
  await expect(
    resolveWslIdentity(
      async (d, args, user) =>
        args[1] === "passwd" ? "tester:x:1001:1000:Test:/home/tester:/bin/bash\n" : execute(d, args, user),
      "Ubuntu",
    ),
  ).rejects.toThrow("changed")
})

const native = process.platform === "linux" ? test : test.skip
native("publishes a content-addressed runtime once and verifies it without rewriting", async () => {
  const home = await mkdtemp(join(tmpdir(), "bharatcode-wsl-provision-"))
  const sourcePath = join(home, "source")
  const bytes = Buffer.from("synthetic executable")
  const execute: WslExecute = async (_distro, args) => {
    const child = Bun.spawn(args, { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "ignore" })
    const output = await new Response(child.stdout).text()
    if ((await child.exited) !== 0) throw new Error("Provisioning failed")
    return output
  }
  const input = {
    execute,
    distro: "Ubuntu",
    identity: { user: "tester", uid: process.getuid!(), home },
    channel: "test",
    sourcePath,
    manifest: {
      schema: 1 as const,
      source_sha: "1".repeat(40),
      version: "1.15.35",
      channel: "dev" as const,
      arch: "x64" as const,
      filename: "bharatcode-runtime-linux-x64-glibc",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    install: true,
  }
  try {
    await writeFile(sourcePath, bytes)
    await expect(provisionWslRuntime({ ...input, install: false })).rejects.toThrow()
    const installed = await provisionWslRuntime(input)
    expect(await readFile(installed)).toEqual(bytes)
    await writeFile(sourcePath, "changed source must not overwrite existing runtime")
    expect(await provisionWslRuntime(input)).toBe(installed)
    expect(await provisionWslRuntime({ ...input, install: false })).toBe(installed)
    expect(await readFile(installed)).toEqual(bytes)
    await chmod(installed, 0o700)
    await expect(provisionWslRuntime(input)).rejects.toThrow()
    await chmod(installed, 0o500)
    await link(installed, join(home, "alias"))
    await expect(provisionWslRuntime(input)).rejects.toThrow()
    await rm(join(home, "alias"))
    await rm(installed)
    await symlink(sourcePath, installed)
    await expect(provisionWslRuntime(input)).rejects.toThrow()
    expect(await readFile(sourcePath, "utf8")).toContain("changed source")
    await rm(installed)
    await rmdir(dirname(installed))
    await expect(provisionWslRuntime(input)).rejects.toThrow()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
