import { $ } from "bun"

await $`bun run install-electron`

await import("./prebuild")
