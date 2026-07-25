#!/usr/bin/env bun
import { $ } from "bun"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { recoveryCliFilename, requireRecoveryCliPlatform } from "./recovery-cli-contract"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.resolve(desktopDir, "../opencode")

export async function stageRecoveryCli(input: { distDir: string; resourcesDir: string; platform: string }) {
  const platform = requireRecoveryCliPlatform(input.platform)
  const binary = platform === "win32" ? "bharatcode.exe" : "bharatcode"
  const matches = (
    await Array.fromAsync(new Bun.Glob(`*/bin/${binary}`).scan({ cwd: input.distDir, onlyFiles: true }))
  ).toSorted()
  if (matches.length !== 1) throw new Error(`Expected exactly one native recovery CLI, found ${matches.length}`)
  const source = path.join(input.distDir, matches[0]!)
  const destination = path.join(input.resourcesDir, recoveryCliFilename(platform))
  await mkdir(input.resourcesDir, { recursive: true })
  await copyFile(source, destination)
  if (platform !== "win32") await chmod(destination, 0o755)
  return { source, destination }
}

export async function buildAndStageRecoveryCli() {
  await $`bun script/build.ts --single --baseline`.cwd(opencodeDir)
  return stageRecoveryCli({
    distDir: path.join(opencodeDir, "dist"),
    resourcesDir: path.join(desktopDir, "resources"),
    platform: process.platform,
  })
}

if (import.meta.main) await buildAndStageRecoveryCli()
