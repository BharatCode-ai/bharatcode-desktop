import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { BharatCodeDictation } from "@/bharatcode/dictation"

const model: BharatCodeCatalog.Model = {
  id: "current-speech-model",
  ownedBy: "bharatcode",
  modality: "audio_transcription",
  endpoint: "/v1/audio/transcriptions",
  protocol: "openai_audio_transcriptions",
  status: "live",
  displayName: "Speech",
  maxInputMb: 1,
  metadata: { input: ["audio"], output: ["text"] },
}
const audio = { audio: Buffer.from("synthetic-audio").toString("base64"), mimeType: "audio/webm;codecs=opus" }

function run<A, E>(
  effect: Effect.Effect<A, E, BharatCodeDictation.Service>,
  options: {
    models?: readonly BharatCodeCatalog.Model[]
    fetch?: (url: string | URL | Request, init?: RequestInit) => Effect.Effect<Response, BharatCodeAccount.Error>
    catalog?: (force: boolean) => void
    timeoutMs?: number
  } = {},
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        BharatCodeDictation.layerWith({ timeoutMs: options.timeoutMs }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(BharatCodeCatalog.Service, {
                list: (input) =>
                  Effect.sync(() => {
                    options.catalog?.(input?.force ?? false)
                    return options.models ?? [model]
                  }),
              }),
              Layer.mock(BharatCodeAccount.Service, {
                authenticatedFetch: options.fetch ?? (() => Effect.die("must not send audio")),
              }),
            ),
          ),
        ),
      ),
    ),
  )
}

describe("runtime-owned dictation", () => {
  test("is unavailable without a live eligible catalog entry and never falls back to retired Whisper", async () => {
    expect(await run(BharatCodeDictation.use.status(), { models: [] })).toEqual({ available: false })
    await expect(run(BharatCodeDictation.use.transcribe(audio), { models: [] })).rejects.toMatchObject({
      reason: "unavailable",
    })
    expect(
      await run(BharatCodeDictation.use.status(), {
        models: [{ ...model, endpoint: "https://untrusted.example/upload" }],
      }),
    ).toEqual({ available: false })
  })

  test("rechecks the catalog and sends only the selected model to the fixed authenticated endpoint", async () => {
    const forced: boolean[] = []
    const result = await run(BharatCodeDictation.use.transcribe(audio), {
      catalog: (force) => forced.push(force),
      fetch: (url, init) =>
        Effect.promise(async () => {
          expect(url).toBe("https://bharatcode.ai/api/model/v1/audio/transcriptions")
          expect(init?.method).toBe("POST")
          expect(init?.signal).toBeDefined()
          const form = init?.body as FormData
          expect(form.get("model")).toBe(model.id)
          expect(form.get("response_format")).toBe("json")
          const file = form.get("file") as File
          expect(file.name).toBe("dictation.webm")
          expect(await file.text()).toBe("synthetic-audio")
          return Response.json({ text: "  Hello world  ", language: "en", duration: 1.2, token: "must-not-leak" })
        }),
    })
    expect(forced).toEqual([true])
    expect(result).toEqual({ text: "Hello world", language: "en", duration: 1.2 })
  })

  test("rejects invalid MIME/base64, empty data and catalog size violations before upload", async () => {
    for (const input of [
      { ...audio, mimeType: "text/html" },
      { ...audio, mimeType: "constructor" },
      { ...audio, mimeType: "__proto__" },
      { ...audio, audio: "%%%" },
      { ...audio, audio: "" },
      { ...audio, audio: Buffer.alloc(1_000_001).toString("base64") },
    ]) {
      await expect(run(BharatCodeDictation.use.transcribe(input))).rejects.toMatchObject({ reason: "invalid_audio" })
    }
  })

  test("does not expose response bodies or misclassify access denial as logout", async () => {
    for (const status of [401, 402, 403, 429, 500, 503]) {
      const failure = await run(BharatCodeDictation.use.transcribe(audio), {
        fetch: () => Effect.succeed(new Response("secret-recharge-url", { status })),
      }).catch((error) => error)
      expect(failure.reason).toBe(
        status === 401 ? "sign_in" : status === 402 || status === 403 ? "access" : "unavailable",
      )
      expect(JSON.stringify(failure)).not.toContain("secret-recharge-url")
    }
  })

  test("bounds response reading and aborts the outbound request", async () => {
    let signal: AbortSignal | null | undefined
    await expect(
      run(BharatCodeDictation.use.transcribe(audio), {
        timeoutMs: 10,
        fetch: (_url, init) =>
          Effect.sync(() => {
            signal = init?.signal
            return new Response(new ReadableStream({ start() {} }))
          }),
      }),
    ).rejects.toMatchObject({ reason: "unavailable" })
    expect(signal?.aborted).toBe(true)
  })

  test("rejects malformed successful responses instead of silently inserting an empty transcript", async () => {
    for (const payload of [null, {}, { text: 3 }, { text: "ok", duration: -1 }, { text: "ok", language: {} }]) {
      await expect(
        run(BharatCodeDictation.use.transcribe(audio), { fetch: () => Effect.succeed(Response.json(payload)) }),
      ).rejects.toMatchObject({ reason: "unavailable" })
    }
  })
})
