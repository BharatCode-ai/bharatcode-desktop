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

export function dictationShortcutLabel(platform = typeof navigator === "object" ? navigator.platform : "") {
  return /(Mac|iPod|iPhone|iPad)/.test(platform) ? "Cmd+Shift+M" : "Ctrl+Shift+M"
}

export function isDictationCancelShortcut(event: Pick<KeyboardEvent, "key">) {
  return event.key === "Escape" || event.key === "Esc"
}

export function dictationStatusLabel(state: "idle" | "recording" | "transcribing") {
  if (state === "recording") return "Recording..."
  if (state === "transcribing") return "Transcribing..."
  return ""
}
