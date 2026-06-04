import { BHARATCODE_OAUTH, getBharatCodeAccessToken } from "./bharatcode-auth"
import type { DictationAudioInput, DictationTranscription } from "../preload/types"

type TranscribeOptions = {
  home?: string
  fetchImpl?: typeof fetch
}

const STT_MODEL = "whisper-large-v3-turbo"

function transcriptionEndpoint() {
  return new URL("audio/transcriptions", `${BHARATCODE_OAUTH.modelProxy}/`).toString()
}

async function responseMessage(response: Response) {
  const body = await response.text().catch(() => "")
  if (!body) return `BharatCode dictation failed (${response.status})`
  try {
    const json = JSON.parse(body)
    return json.error?.message || json.error || json.detail || body
  } catch {
    return body
  }
}

export async function transcribeDictationAudio(
  audio: DictationAudioInput,
  { home, fetchImpl = fetch }: TranscribeOptions = {},
): Promise<DictationTranscription> {
  if (!audio.buffer.byteLength) throw new Error("Dictation recording was empty.")

  const token = await getBharatCodeAccessToken({ home, fetchImpl })
  const form = new FormData()
  form.set(
    "file",
    new Blob([audio.buffer], { type: audio.mimeType || "audio/webm" }),
    audio.filename || "dictation.webm",
  )
  form.set("model", STT_MODEL)
  form.set("response_format", "verbose_json")

  const response = await fetchImpl(transcriptionEndpoint(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })

  if (!response.ok) throw new Error(await responseMessage(response))

  const payload = await response.json()
  const text = typeof payload.text === "string" ? payload.text.trim() : ""
  return {
    text,
    language: typeof payload.language === "string" ? payload.language : undefined,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
  }
}
