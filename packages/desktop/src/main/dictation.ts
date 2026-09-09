import type { DictationAudioInput, DictationTranscription } from "../preload/types"

type TranscribeOptions = {
  fetchImpl?: typeof fetch
  getAccessToken?: () => Promise<string>
}

const STT_ENDPOINT = "https://bharatcode.ai/api/model/v1/audio/transcriptions"
const STT_MODEL = "whisper-large-v3-turbo"

async function responseMessage(response: Response) {
  const body = await response.text().catch(() => "")
  if (response.status === 401 || response.status === 403) {
    return "BharatCode dictation is not authorized. Sign in to BharatCode again and retry dictation."
  }
  if (response.status >= 500) {
    return `BharatCode dictation service is unavailable right now (${response.status}). Try again in a few minutes.`
  }
  return body || `BharatCode dictation failed (${response.status})`
}

export async function transcribeDictationAudio(
  audio: DictationAudioInput,
  options: TranscribeOptions = {},
): Promise<DictationTranscription> {
  if (!audio.buffer.byteLength) throw new Error("Dictation recording was empty.")
  if (!options.getAccessToken) {
    throw new Error("BharatCode dictation requires the shared account runtime.")
  }

  const form = new FormData()
  form.set(
    "file",
    new Blob([audio.buffer], { type: audio.mimeType || "audio/webm" }),
    audio.filename || "dictation.webm",
  )
  form.set("model", STT_MODEL)
  form.set("response_format", "verbose_json")

  const response = await (options.fetchImpl ?? fetch)(STT_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${await options.getAccessToken()}` },
    body: form,
  })
  if (!response.ok) throw new Error(await responseMessage(response))

  const payload = (await response.json()) as { text?: unknown; language?: unknown; duration?: unknown }
  return {
    text: typeof payload.text === "string" ? payload.text.trim() : "",
    language: typeof payload.language === "string" ? payload.language : undefined,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
  }
}
