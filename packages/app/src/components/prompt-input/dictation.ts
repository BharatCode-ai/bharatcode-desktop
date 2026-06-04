const RECORDER_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"]

export function preferredDictationMimeType(isSupported = (mime: string) => MediaRecorder.isTypeSupported(mime)) {
  return RECORDER_MIME_TYPES.find((mime) => isSupported(mime)) ?? ""
}

export function audioExtensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("mp4")) return "m4a"
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("wav")) return "wav"
  return "webm"
}

export function dictationFilename(mimeType: string, now = Date.now()) {
  return `bharatcode-dictation-${now}.${audioExtensionForMimeType(mimeType)}`
}

export function dictationInsertionText({
  textBeforeCursor,
  transcript,
  textAfterCursor,
}: {
  textBeforeCursor: string
  transcript: string
  textAfterCursor: string
}) {
  const text = transcript.trim()
  if (!text) return ""

  const prefix = textBeforeCursor.length > 0 && !/\s$/.test(textBeforeCursor) ? " " : ""
  const suffix =
    textAfterCursor.length > 0 && !/^\s/.test(textAfterCursor) && !/^[,.;:!?)]/.test(textAfterCursor) ? " " : ""

  return `${prefix}${text}${suffix}`
}
