import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("runtime API origin carries real catalog, model, stream and dictation traffic only to the chosen loopback server", async () => {
  await using directory = await tmpdir()
  const seen: string[] = []
  const errors: string[] = []
  let authorization: URL | undefined
  let token = ""
  const coding = {
    id: "synthetic-coder",
    object: "model",
    owned_by: "bharatcode",
    modality: "chat",
    endpoint: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    runtime: "fixture",
    status: "live",
    display_name: "Synthetic Coder",
    context_window: 32768,
    max_output_tokens: 2048,
    metadata: { input: ["text"], output: ["text"], toolCalling: true, reasoning: false },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      seen.push(url.pathname)
      const fail = (message: string) => {
        errors.push(message)
        return Response.json({ error: message }, { status: 400 })
      }
      if (url.pathname === "/auth/v1/oauth/authorize") {
        authorization = url
        const callback = new URL(url.searchParams.get("redirect_uri")!)
        callback.searchParams.set("code", "synthetic-code")
        callback.searchParams.set("state", url.searchParams.get("state")!)
        return new Response(null, { status: 302, headers: { location: callback.href } })
      }
      if (url.pathname === "/auth/v1/oauth/token") {
        const form = new URLSearchParams(await request.text())
        if (
          form.get("grant_type") !== "authorization_code" ||
          form.get("code") !== "synthetic-code" ||
          createHash("sha256").update(form.get("code_verifier")!).digest("base64url") !==
            authorization?.searchParams.get("code_challenge")
        )
          return fail("invalid synthetic PKCE")
        token = `e30.${Buffer.from(JSON.stringify({ iss: `${url.origin}/auth/v1`, sub: "synthetic-user" })).toString("base64url")}.synthetic`
        return Response.json({ access_token: token, refresh_token: "synthetic-refresh", expires_in: 3600 })
      }
      if (url.pathname === "/api/model/v1/models") {
        if (request.headers.has("authorization")) return fail("catalog must not receive credentials")
        return Response.json({
          object: "list",
          data: [
            coding,
            {
              ...coding,
              id: "synthetic-speech",
              modality: "audio_transcription",
              endpoint: "/v1/audio/transcriptions",
              protocol: "openai_audio_transcriptions",
              max_input_mb: 1,
              metadata: { input: ["audio"], output: ["text"] },
            },
            { ...coding, id: "external-endpoint", endpoint: "https://bharatcode.ai/api/model/v1/chat/completions" },
          ],
        })
      }
      if (!token || request.headers.get("authorization") !== `Bearer ${token}`)
        return fail("invalid synthetic authorization")
      if (url.pathname === "/auth/v1/oauth/userinfo")
        return Response.json({ sub: "synthetic-user", email: "fixture@example.test" })
      if (url.pathname === "/redirect")
        return new Response(null, { status: 307, headers: { location: `${url.origin}/must-not-follow` } })
      if (url.pathname === "/api/model/v1/audio/transcriptions") {
        const form = await request.formData()
        if (form.get("model") !== "synthetic-speech" || (await (form.get("file") as File).text()) !== "synthetic-audio")
          return fail("invalid synthetic dictation")
        return Response.json({ text: "fixture transcript" })
      }
      if (url.pathname === "/api/model/v1/chat/completions") {
        const body = (await request.json()) as { model: string; stream?: boolean; max_tokens: number }
        if (body.model !== coding.id || body.max_tokens !== 16) return fail("model or allowance changed")
        if (body.stream) {
          const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: coding.id }
          return new Response(
            [
              {
                ...chunk,
                choices: [{ index: 0, delta: { role: "assistant", content: "fixture answer" }, finish_reason: null }],
              },
              {
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
              },
            ]
              .map((item) => `data: ${JSON.stringify(item)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          )
        }
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: coding.id,
          choices: [{ index: 0, message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      }
      return fail("unexpected path")
    },
  })
  const child = Bun.spawn([process.execPath, "--no-env-file", "test/fixture/bharatcode-api-runtime.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: directory.path,
      USERPROFILE: directory.path,
      OPENCODE_TEST_HOME: directory.path,
      XDG_DATA_HOME: path.join(directory.path, "data"),
      XDG_CONFIG_HOME: path.join(directory.path, "config"),
      XDG_STATE_HOME: path.join(directory.path, "state"),
      XDG_CACHE_HOME: path.join(directory.path, "cache"),
      APPDATA: path.join(directory.path, "roaming"),
      LOCALAPPDATA: path.join(directory.path, "local"),
      BHARATCODE_AUTH_URL: server.url.origin,
      BHARATCODE_API_BASE_URL: server.url.origin,
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory.path, "managed"),
      OPENCODE_DB: ":memory:",
    },
  })
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(errors).toEqual([])
    expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("isolated-auth-catalog-model-stream-dictation-boundaries: passed")
    expect(seen.filter((item) => item === "/api/model/v1/chat/completions")).toHaveLength(2)
    expect(seen).not.toContain("/must-not-follow")
    expect(seen).toContain("/api/model/v1/audio/transcriptions")
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
    await server.stop(true)
  }
}, 40_000)
