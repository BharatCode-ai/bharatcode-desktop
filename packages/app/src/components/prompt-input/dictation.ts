import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

type Recording = {
  recorder: {
    state: string
    mimeType: string
    ondataavailable?: ((event: BlobEvent) => void) | null
    onstop?: ((event: Event) => void) | null
    onerror?: ((event: ErrorEvent) => void) | null
    start(timeslice: number): void
    stop(): void
  }
  release(): void
}

export async function captureDictation(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => stream.getTracks().forEach((track) => track.stop())
  try {
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    )
    return { recorder: new MediaRecorder(stream, mimeType ? { mimeType } : undefined), release }
  } catch (error) {
    release()
    throw error
  }
}

export function createDictationController(options: {
  scope: () => unknown
  maxBytes: () => number | undefined
  capture: () => Promise<Recording>
  transcribe: (blob: Blob, signal: AbortSignal) => Promise<string>
  insert: (text: string) => void
}) {
  const [state, setState] = createStore<{
    phase: "idle" | "requesting" | "recording" | "transcribing"
    error?: "microphone" | "size" | "request"
  }>({ phase: "idle" })
  let generation = 0
  let disposed = false
  let media: Recording | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  const release = () => {
    clearTimeout(timer)
    timer = undefined
    const current = media
    media = undefined
    if (!current) return
    current.recorder.ondataavailable = null
    current.recorder.onstop = null
    current.recorder.onerror = null
    try {
      if (current.recorder.state !== "inactive") current.recorder.stop()
    } catch {
      /* A recorder may already have stopped; tracks must still be released. */
    } finally {
      current.release()
    }
  }
  const cancel = () => {
    generation++
    request?.abort()
    request = undefined
    release()
    setState({ phase: "idle", error: undefined })
  }
  createEffect(() => {
    options.scope()
    cancel()
  })
  onCleanup(() => {
    disposed = true
    cancel()
  })
  const stop = () => {
    if (state.phase !== "recording") return
    setState("phase", "transcribing")
    try {
      media?.recorder.stop()
    } catch {
      cancel()
      setState("error", "microphone")
    }
  }
  const start = async () => {
    const limit = options.maxBytes()
    if (disposed || state.phase !== "idle" || !limit) return
    const attempt = ++generation
    const key = options.scope()
    const current = () => !disposed && attempt === generation && options.scope() === key
    setState({ phase: "requesting", error: undefined })
    try {
      const acquired = await options.capture()
      if (!current()) {
        acquired.release()
        return
      }
      media = acquired
      const chunks: Blob[] = []
      let size = 0
      acquired.recorder.ondataavailable = ({ data }) => {
        if (!current()) return
        size += data.size
        if (size > limit) {
          cancel()
          setState("error", "size")
          return
        }
        if (data.size) chunks.push(data)
      }
      acquired.recorder.onerror = () => {
        if (current()) {
          cancel()
          setState("error", "microphone")
        }
      }
      acquired.recorder.onstop = () => {
        if (!current()) return
        const clip = new Blob(chunks, { type: acquired.recorder.mimeType || chunks[0]?.type || "audio/webm" })
        release()
        if (!clip.size) {
          setState({ phase: "idle", error: "microphone" })
          return
        }
        setState("phase", "transcribing")
        const controller = new AbortController()
        request = controller
        void (async () => options.transcribe(clip, controller.signal))()
          .then((text) => {
            if (current()) options.insert(text)
          })
          .catch(() => {
            if (current()) setState("error", "request")
          })
          .finally(() => {
            if (current()) {
              request = undefined
              setState("phase", "idle")
            }
          })
      }
      acquired.recorder.start(250)
      setState("phase", "recording")
      timer = setTimeout(() => {
        if (current()) stop()
      }, 120_000)
    } catch {
      if (current()) {
        release()
        setState({ phase: "idle", error: "microphone" })
      }
    }
  }
  return { state, start, cancel, stop }
}

export function insertDictation(editor: HTMLDivElement | undefined, transcript: string) {
  if (!editor || !transcript.trim()) return
  editor.focus()
  const selection = window.getSelection()
  if (!selection) return
  const range =
    selection.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
      ? selection.getRangeAt(0)
      : document.createRange()
  if (!editor.contains(range.startContainer)) {
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  const after = range.cloneRange()
  after.selectNodeContents(editor)
  after.setStart(range.endContainer, range.endOffset)
  const text = `${before.toString() && !/\s$/.test(before.toString()) ? " " : ""}${transcript.trim()}${after.toString() && !/^[\s,.;:!?)]/.test(after.toString()) ? " " : ""}`
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromDictation", data: text }))
}
