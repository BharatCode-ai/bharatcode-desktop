import { describe, expect, test } from "bun:test"

import { transcribeDictationAudio } from "./dictation"

const audio = {
  buffer: new Uint8Array([1, 2, 3, 4]).buffer,
  mimeType: "audio/webm;codecs=opus",
  filename: "dictation.webm",
}

describe("BharatCode desktop dictation", () => {
  test("uses only an explicitly composed shared-account token provider", async () => {
    let request: { url: string; authorization: string | null; body: unknown } | undefined
    const result = await transcribeDictationAudio(audio, {
      getAccessToken: async () => "shared-runtime-token",
      fetchImpl: async (input, init) => {
        request = {
          url: input.toString(),
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body,
        }
        return Response.json({ text: "create a README", language: "en", duration: 1.25 })
      },
    })

    expect(result).toEqual({ text: "create a README", language: "en", duration: 1.25 })
    expect(request?.url).toBe("https://bharatcode.ai/api/model/v1/audio/transcriptions")
    expect(request?.authorization).toBe("Bearer shared-runtime-token")
    expect(request?.body).toBeInstanceOf(FormData)
  })

  test("fails closed without the shared account composition", async () => {
    await expect(transcribeDictationAudio(audio)).rejects.toThrow("shared account runtime")
  })

  test("rejects empty audio before reading account state", async () => {
    let accountReads = 0
    await expect(
      transcribeDictationAudio(
        { ...audio, buffer: new ArrayBuffer(0) },
        { getAccessToken: async () => (accountReads++, "token") },
      ),
    ).rejects.toThrow("Dictation recording was empty")
    expect(accountReads).toBe(0)
  })

  test("wraps upstream service failures", async () => {
    await expect(
      transcribeDictationAudio(audio, {
        getAccessToken: async () => "shared-runtime-token",
        fetchImpl: async () => new Response("Internal Server Error", { status: 500 }),
      }),
    ).rejects.toThrow("BharatCode dictation service is unavailable")
  })
})
