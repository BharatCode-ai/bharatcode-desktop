// Bundled into packages/core/src/capabilities/memory-server.json by
// script/bundle-memory-server.ts and shipped as the Marketplace "Project memory" capability.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { BharatCodeMemory } from "./memory"

const root = process.env.BHARATCODE_MEMORY_DIR
if (!root) throw new Error("BHARATCODE_MEMORY_DIR is required")
// MCP runs local servers in the project directory.
const file = await BharatCodeMemory.locate(root, process.cwd())

const server = new Server(
  { name: "bharatcode-memory", version: "1.1.0" },
  { capabilities: { tools: { listChanged: true } }, instructions: BharatCodeMemory.instructions(file) },
)

// Read the file on every listing so facts saved here, in another chat, or edited by
// hand are always current.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: BharatCodeMemory.tools(await BharatCodeMemory.facts(file)),
}))

// Each change rewrites the whole file, and the SDK handles requests concurrently (for
// example parallel tool calls), so changes run one at a time to never lose a fact.
const queue = { last: Promise.resolve() as Promise<unknown> }
const serial = <T>(change: () => Promise<T>) => {
  const next = queue.last.then(change)
  queue.last = next.catch(() => {})
  return next
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {}
  const fact = typeof args.fact === "string" ? args.fact : ""
  const number = typeof args.number === "number" ? args.number : Number.NaN
  const result = await serial(async () => {
    if (request.params.name === "save_memory") return BharatCodeMemory.save(file, fact)
    if (request.params.name === "update_memory") return BharatCodeMemory.update(file, number, fact)
    if (request.params.name === "forget_memory") return BharatCodeMemory.forget(file, number)
  })
  if (!result) return { isError: true, content: [{ type: "text", text: `Unknown tool ${request.params.name}.` }] }
  // Clients re-read the tool list on this notification, which carries the new facts.
  if (result.saved) await server.sendToolListChanged()
  return { isError: result.error, content: [{ type: "text", text: result.message }] }
})

await server.connect(new StdioServerTransport())
