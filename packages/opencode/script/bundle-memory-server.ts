#!/usr/bin/env bun
// Rebuilds the bundled Project memory MCP server after changing src/bharatcode/memory*.ts.
import path from "path"

const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "../src/bharatcode/memory-server.ts")],
  target: "node",
  format: "esm",
  minify: true,
})
if (!result.success) throw new AggregateError(result.logs, "memory server build failed")

await Bun.write(
  path.join(import.meta.dir, "../../core/src/capabilities/memory-server.json"),
  JSON.stringify(
    {
      "memory-server.mjs": await result.outputs[0].text(),
      "ATTRIBUTION.md": [
        "# Project memory attribution",
        "",
        "The save_memory tool follows Qwen Code's memory tool (Apache-2.0): https://github.com/QwenLM/qwen-code",
        "The per-chat memory budget follows Engram (MIT): https://github.com/kenz1117/dsh-engram",
        "The bundled MCP SDK is MIT licensed: https://github.com/modelcontextprotocol/typescript-sdk",
        "",
      ].join("\n"),
    },
    null,
    2,
  ) + "\n",
)

console.log("Built packages/core/src/capabilities/memory-server.json")
