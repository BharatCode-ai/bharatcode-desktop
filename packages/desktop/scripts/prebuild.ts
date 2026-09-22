#!/usr/bin/env bun
import { $ } from "bun"

import { stageCliToResources, resolveChannel } from "./utils"
import { stageWslRuntimeFromEnvironment } from "./stage-wsl-runtime"
import { Script } from "@opencode-ai/script"

const channel = resolveChannel()
if (process.platform === "win32" && (channel !== "dev" || process.env.BHARATCODE_WSL_RUNTIME)) {
  await stageWslRuntimeFromEnvironment({ cwd: process.cwd(), env: process.env, packageVersion: Script.version })
}
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build.ts --single --skip-install --skip-embed-web-ui`
await stageCliToResources()
await $`cd ../opencode && bun script/build-node.ts`
