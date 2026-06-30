import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { BHARATCODE_OAUTH } from "./bharatcode-auth"
import { transcribeDictationAudio } from "./dictation"

describe("BharatCode desktop dictation", () => {
  test("posts recorded audio to the BharatCode STT endpoint with the OAuth bearer token", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-dictation-"))
    const credentialsPath = join(home, ".bharatcode", "credentials.json")
    let request: { url: string; authorization: string | null; body: unknown } | null = null

    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      request = {
        url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ?? null,
      }

      return Response.json({ text: "create a README", language: "en", duration: 1.25 })
    }

    try {
      await mkdir(dirname(credentialsPath), { recursive: true })
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      )

      const result = await transcribeDictationAudio(
        {
          buffer: new Uint8Array([1, 2, 3, 4]).buffer,
          mimeType: "audio/webm;codecs=opus",
          filename: "dictation.webm",
        },
        { home, fetchImpl },
      )

      expect(result).toEqual({ text: "create a README", language: "en", duration: 1.25 })
      if (!request) throw new Error("fetch was not called")
      expect(request.url).toBe(`${BHARATCODE_OAUTH.modelProxy}/audio/transcriptions`)
      expect(request.authorization).toBe("Bearer access-token")
      expect(request.body).toBeInstanceOf(FormData)
      if (!(request.body instanceof FormData)) throw new Error("dictation request body was not form data")
      const body = request.body
      expect(body.get("model")).toBe("whisper-large-v3-turbo")
      expect(body.get("response_format")).toBe("verbose_json")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("rejects empty audio before calling the STT endpoint", async () => {
    await expect(
      transcribeDictationAudio(
        {
          buffer: new ArrayBuffer(0),
          mimeType: "audio/webm",
          filename: "empty.webm",
        },
        {
          fetchImpl: async () => {
            throw new Error("fetch should not be called")
          },
        },
      ),
    ).rejects.toThrow("Dictation recording was empty")
  })

  test("wraps upstream STT server failures with an actionable BharatCode message", async () => {
    const home = await mkdtemp(join(tmpdir(), "bharatcode-dictation-"))
    const credentialsPath = join(home, ".bharatcode", "credentials.json")

    try {
      await mkdir(dirname(credentialsPath), { recursive: true })
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      )

      await expect(
        transcribeDictationAudio(
          {
            buffer: new Uint8Array([1, 2, 3, 4]).buffer,
            mimeType: "audio/webm;codecs=opus",
            filename: "dictation.webm",
          },
          {
            home,
            fetchImpl: async () =>
              new Response("Internal Server Error", {
                status: 500,
                headers: { "content-type": "text/plain" },
              }),
          },
        ),
      ).rejects.toThrow("BharatCode dictation service is unavailable")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
