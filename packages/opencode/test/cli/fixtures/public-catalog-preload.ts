// Runs only in the isolated CLI test child; no production endpoint is contacted.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (
    String(input) !== "https://bharatcode.ai/api/model/v1/models" ||
    init?.method !== "GET" ||
    init.credentials !== "omit" ||
    init.redirect !== "error" ||
    new Headers(init.headers).has("authorization")
  )
    throw new Error("Unexpected network request in catalog fixture")
  return Response.json({
    object: "list",
    data: [
      {
        id: "fixture-coder",
        object: "model",
        owned_by: "bharatcode",
        modality: "chat",
        endpoint: "/v1/chat/completions",
        protocol: "openai_chat_completions",
        status: "live",
        display_name: "Fixture Coder",
        context_window: 32_000,
        max_output_tokens: 4_096,
        metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
      },
    ],
  })
}) as typeof fetch
