import { chmod, copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { normalizeChannel } from "../src/main/branding"
import { platformPackageName, platformBinaryName } from "../../opencode/script/distribution.mjs"

export function resolveChannel() {
  return normalizeChannel(process.env.BHARATCODE_CHANNEL ?? process.env.OPENCODE_CHANNEL)
}

export function bundledCliFilename(platform = process.platform) {
  return platform === "win32" ? "bharatcode-cli.exe" : "bharatcode-cli"
}

// Called only after this checkout's CLI build. Never download a different
// product/version from npm to fill a missing release artifact.
export async function stageCliToResources() {
  const target = { os: process.platform, arch: process.arch }
  const source = join("../opencode/dist", platformPackageName(target), "bin", platformBinaryName(process.platform))
  const destination = join("resources", bundledCliFilename())
  await mkdir("resources", { recursive: true })
  await copyFile(source, destination)
  if (process.platform !== "win32") await chmod(destination, 0o755)
  console.log(`Staged same-source CLI: ${destination}`)
}
