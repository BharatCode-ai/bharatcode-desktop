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

// Instructions are read once per connection, so saved facts load into every new chat.
const server = new Server(
  { name: "bharatcode-memory", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: BharatCodeMemory.instructions({ facts: await BharatCodeMemory.facts(file), file }),
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [BharatCodeMemory.TOOL] }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== BharatCodeMemory.TOOL.name)
    return { isError: true, content: [{ type: "text", text: `Unknown tool ${request.params.name}.` }] }
  const fact = request.params.arguments?.fact
  const result = await BharatCodeMemory.save(file, typeof fact === "string" ? fact : "")
  return { isError: result.error, content: [{ type: "text", text: result.message }] }
})

await server.connect(new StdioServerTransport())
