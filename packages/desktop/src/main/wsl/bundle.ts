import { app } from "electron"
import { join, posix, win32 } from "node:path"
import { verifyWslArtifact, wslRuntimeFilename } from "./artifact"
import { provisionWslRuntime, resolveWslIdentity, type WslExecute } from "./provision"
import { runWsl, type RunWslOptions } from "./runtime"
import { wslArgs } from "./args"

export async function bundledWslRuntime(distro: string, install: boolean, options?: RunWslOptions) {
  const arch = process.arch
  if (arch !== "x64" && arch !== "arm64") throw new Error("Unsupported WSL architecture")
  const source = import.meta.env.BHARATCODE_SOURCE_SHA
  if (!/^[0-9a-f]{40}$/.test(source ?? "")) throw new Error("Verified WSL build identity is unavailable")
  const root = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), "wsl-runtime")
  const runtimePath = join(root, wslRuntimeFilename(arch))
  const manifest = await verifyWslArtifact({
    runtimePath,
    manifestPath: join(root, "manifest.json"),
    expectedSourceSha: source,
    expectedVersion: app.getVersion(),
    expectedArch: arch,
    expectedChannel: import.meta.env.OPENCODE_CHANNEL,
  })
  const execute: WslExecute = async (distribution, args, user) => {
    const result = await runWsl(wslArgs(args, distribution, user), options)
    if (result.code !== 0) throw new Error("WSL runtime operation failed")
    return result.stdout
  }
  const identity = await resolveWslIdentity(execute, distro)
  const sourcePath = (await execute(distro, ["/usr/bin/wslpath", "-u", "--", runtimePath], identity.user)).trimEnd()
  if (!posix.isAbsolute(sourcePath) || posix.normalize(sourcePath) !== sourcePath || /[\r\n\u0000]/u.test(sourcePath)) {
    throw new Error("Invalid WSL runtime translation")
  }
  const roundTrip = (await execute(distro, ["/usr/bin/wslpath", "-w", "--", sourcePath], identity.user)).trimEnd()
  if (win32.normalize(roundTrip).toLowerCase() !== win32.normalize(runtimePath).toLowerCase()) {
    throw new Error("WSL runtime path round trip failed")
  }
  const installedPath = await provisionWslRuntime({
    execute,
    distro,
    identity,
    sourcePath,
    manifest,
    channel: import.meta.env.OPENCODE_CHANNEL,
    install,
  })
  return { manifest, identity, installedPath }
}
