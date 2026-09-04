export type Attempt = {
  readonly url: string
  readonly method: string
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

export function createBharatCodeApiFixture() {
  const attempts: Attempt[] = []
  let chatCalls = 0
  const allowedOrigins = new Set(["https://bharatcode.ai", "https://evgvlcaxfpwupaiwzqqm.supabase.co"])

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    attempts.push({ url: url.href, method: request.method })
    if (!allowedOrigins.has(url.origin)) return json({ error: "forbidden-origin" }, 421)

    if (url.pathname === "/auth/v1/oauth/token" && request.method === "POST") {
      return json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_in: 3600,
      })
    }
    if (
      url.pathname === "/auth/v1/oauth/userinfo" &&
      request.headers.get("authorization") === "Bearer fixture-access"
    ) {
      return json({
        sub: "usr_product_core",
        email: "product-core@bharatcode.ai",
        email_verified: true,
        name: "Product Core",
      })
    }
    if (url.pathname === "/api/model/v1/models" && request.headers.get("authorization") === "Bearer fixture-access") {
      return json({
        object: "list",
        data: [
          {
            id: "bharatcode:qwen36-35b-awq-200k",
            object: "model",
            created: 0,
            owned_by: "bharatcode",
            modality: "vision_chat",
            endpoint: "/v1/chat/completions",
            protocol: "openai_chat_completions",
            runtime: "vllm",
            status: "live",
            display_name: "BharatCode Qwen 3.6 35B AWQ 200K",
            context_window: 200_000,
            max_output_tokens: 32_000,
            metadata: { input: ["text", "image"], output: ["text"], toolCalling: true, reasoning: true },
          },
        ],
      })
    }
    if (
      url.pathname === "/api/model/v1/chat/completions" &&
      request.method === "POST" &&
      request.headers.get("authorization") === "Bearer fixture-access"
    ) {
      chatCalls++
      const chunks =
        chatCalls === 1
          ? [
              { delta: { role: "assistant" } },
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_edit",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({ filePath: "answer.txt", oldString: "before", newString: "after" }),
                      },
                    },
                  ],
                },
              },
              { delta: {}, finish_reason: "tool_calls" },
            ]
          : [
              { delta: { role: "assistant" } },
              { delta: { content: "The edit and command completed." } },
              { delta: {}, finish_reason: "stop" },
            ]
      return new Response(
        [
          ...chunks.map(
            (choice) =>
              `data: ${JSON.stringify({ id: `chatcmpl_product_core_${chatCalls}`, object: "chat.completion.chunk", choices: [choice] })}`,
          ),
          `data: ${JSON.stringify({ id: `chatcmpl_product_core_${chatCalls}`, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return json({ error: "fixture-route-not-found" }, 404)
  }

  return {
    attempts,
    allowedOrigins,
    fetch,
    get chatCalls() {
      return chatCalls
    },
  }
}
