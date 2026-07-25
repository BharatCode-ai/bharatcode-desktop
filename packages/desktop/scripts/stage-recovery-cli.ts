#!/usr/bin/env bun
import { $ } from "bun"
import { chmod, copyFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { recoveryCliFilename, recoveryCliPackageName, requireRecoveryCliPlatform } from "./recovery-cli-contract"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.resolve(desktopDir, "../opencode")

export async function stageRecoveryCli(input: {
  distDir: string
  resourcesDir: string
  platform: string
  arch: string
}) {
  const platform = requireRecoveryCliPlatform(input.platform)
  const binary = platform === "win32" ? "bharatcode.exe" : "bharatcode"
  const source = path.join(input.distDir, recoveryCliPackageName(platform, input.arch), "bin", binary)
  const info = await stat(source).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`Native recovery CLI is missing: ${source}`)
  const destination = path.join(input.resourcesDir, recoveryCliFilename(platform))
  await mkdir(input.resourcesDir, { recursive: true })
  await copyFile(source, destination)
  if (platform !== "win32") await chmod(destination, 0o755)
  return { source, destination }
}

export async function buildAndStageRecoveryCli() {
  await $`bun script/build.ts --single --baseline --skip-install`.cwd(opencodeDir)
  return stageRecoveryCli({
    distDir: path.join(opencodeDir, "dist"),
    resourcesDir: path.join(desktopDir, "resources"),
    platform: process.platform,
    arch: process.arch,
  })
}

if (import.meta.main) await buildAndStageRecoveryCli()
