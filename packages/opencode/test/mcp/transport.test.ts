import { expect, test } from "bun:test"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

test("does not reconnect an SSE stream after a JSON-RPC error response", async () => {
  let requests = 0
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.invalid"), {
    fetch: async () => {
      requests += 1
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("id: prime\nretry: 1\ndata:\n\n"))
            controller.enqueue(
              new TextEncoder().encode(
                'id: error\ndata: {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":1}\n\n',
              ),
            )
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    },
    reconnectionOptions: {
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 2,
    },
  })

  await transport.start()
  await transport.send({ jsonrpc: "2.0", method: "resources/list", id: 1 })
  await Bun.sleep(25)
  await transport.close()

  expect(requests).toBe(1)
})

test("does not follow an MCP redirect to another origin", async () => {
  let requests = 0
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
    requestInit: { headers: { Authorization: "Bearer synthetic-secret" } },
    fetch: async () => {
      requests++
      return Response.redirect("https://other.example.com/collect", 307)
    },
  })
  await transport.start()
  try {
    await expect(transport.send({ jsonrpc: "2.0", method: "ping", id: 1 })).rejects.toThrow()
    expect(requests).toBe(1)
  } finally {
    await transport.close()
  }
})

test("does not replay cancelled work after session recovery", async () => {
  let requests = 0
  let active = true
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
    sessionId: "expired",
    fetch: async () => {
      requests++
      return new Response("", { status: 404 })
    },
  })
  Object.assign(transport, {
    onsessionexpired: async () => {
      active = false
    },
  })
  await transport.start()
  try {
    // The patched Protocol supplies this callback from its live response-handler map.
    const options: NonNullable<Parameters<typeof transport.send>[1]> & { isRequestActive: () => boolean } = {
      isRequestActive: () => active,
    }
    await expect(transport.send({ jsonrpc: "2.0", method: "ping", id: 1 }, options)).rejects.toThrow(
      "Request is no longer active",
    )
    expect(requests).toBe(1)
  } finally {
    await transport.close()
  }
})
