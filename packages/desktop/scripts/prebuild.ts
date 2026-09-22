#!/usr/bin/env bun
import { $ } from "bun"

import { stageCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build.ts --single --skip-install --skip-embed-web-ui`
await stageCliToResources()
await $`cd ../opencode && bun script/build-node.ts`
