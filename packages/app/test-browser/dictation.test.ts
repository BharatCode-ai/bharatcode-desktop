import { expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createDictationController, insertDictation } from "@/components/prompt-input/dictation"

// happy-dom does not populate BlobEvent.data; use the browser event shape explicitly.
const audio = (text: string) => Object.assign(new Event("dataavailable"), { data: new Blob([text]), timecode: 0 })

function recording() {
  let stopped = 0
  const recorder = {
    state: "inactive",
    mimeType: "audio/webm",
    ondataavailable: undefined as ((event: BlobEvent) => void) | undefined,
    onstop: undefined as ((event: Event) => void) | undefined,
    onerror: undefined as ((event: ErrorEvent) => void) | undefined,
    start() {
      this.state = "recording"
    },
    stop() {
      this.state = "inactive"
      this.onstop?.(new Event("stop"))
    },
  }
  return {
    recorder,
    release: () => {
      stopped++
    },
    stopped: () => stopped,
  }
}

test("duplicate start is suppressed; navigation cancels a late microphone grant", async () => {
  let grant!: (value: ReturnType<typeof recording>) => void
  let calls = 0
  const instance = createRoot((dispose) => {
    const [key, setKey] = createSignal("A")
    const controller = createDictationController({
      scope: key,
      maxBytes: () => 1000,
      capture: () => {
        calls++
        return new Promise((resolve) => {
          grant = resolve
        })
      },
      transcribe: async () => "not expected",
      insert: () => {
        throw new Error("must not insert")
      },
    })
    return { dispose, controller, setKey }
  })
  const first = instance.controller.start()
  await instance.controller.start()
  expect(calls).toBe(1)
  instance.setKey("B")
  const media = recording()
  grant(media)
  await first
  expect(media.stopped()).toBe(1)
  expect(media.recorder.state).toBe("inactive")
  expect(instance.controller.state.phase).toBe("idle")
  instance.dispose()
})

test("oversize and disposal release audio without uploading", async () => {
  for (const action of ["oversize", "dispose"] as const) {
    const media = recording()
    let uploads = 0
    const instance = createRoot((dispose) => ({
      dispose,
      controller: createDictationController({
        scope: () => "A",
        maxBytes: () => 2,
        capture: async () => media,
        transcribe: async () => {
          uploads++
          return "wrong"
        },
        insert: () => {
          throw new Error("must not insert")
        },
      }),
    }))
    await instance.controller.start()
    if (action === "dispose") instance.dispose()
    else media.recorder.ondataavailable?.(audio("too large"))
    expect(uploads).toBe(0)
    expect(media.stopped()).toBe(1)
    expect(media.recorder.state).toBe("inactive")
    expect(instance.controller.state.phase).toBe("idle")
    if (action === "oversize") expect(instance.controller.state.error).toBe("size")
    instance.dispose()
  }
})

test("transcription failure is sanitized and allows a new recording", async () => {
  const media = recording()
  let completed!: () => void
  const completion = new Promise<void>((resolve) => {
    completed = resolve
  })
  const instance = createRoot((dispose) => ({
    dispose,
    controller: createDictationController({
      scope: () => "A",
      maxBytes: () => 1000,
      capture: async () => media,
      transcribe: async () => {
        throw new Error("secret-token=/private/audio")
      },
      insert: () => {},
    }),
  }))
  await instance.controller.start()
  media.recorder.ondataavailable?.(audio("audio"))
  const unwatch = createRoot((dispose) => {
    createEffect(() => {
      if (instance.controller.state.phase === "idle" && instance.controller.state.error) completed()
    })
    return dispose
  })
  instance.controller.stop()
  await completion
  unwatch()
  expect(instance.controller.state).toEqual({ phase: "idle", error: "request" })
  await instance.controller.start()
  expect(instance.controller.state.phase).toBe("recording")
  expect(instance.controller.state.error).toBeUndefined()
  instance.dispose()
})

test("transcripts are inserted as literal text with input notification", () => {
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  editor.textContent = "Keep this"
  document.body.append(editor)
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  let inputs = 0
  editor.addEventListener("input", () => inputs++)
  insertDictation(editor, "<script>literal</script>")
  expect(editor.textContent).toBe("Keep this <script>literal</script>")
  expect(editor.querySelector("script")).toBeNull()
  expect(inputs).toBe(1)
  editor.remove()
})

test("cancels a late transcript without inserting into another conversation", async () => {
  const media = recording()
  let finish!: (text: string) => void
  const inserted: string[] = []
  const instance = createRoot((dispose) => ({
    dispose,
    controller: createDictationController({
      scope: () => "A",
      maxBytes: () => 1000,
      capture: async () => media,
      transcribe: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      insert: (text) => {
        inserted.push(text)
      },
    }),
  }))
  await instance.controller.start()
  media.recorder.ondataavailable?.(audio("audio"))
  instance.controller.stop()
  expect(instance.controller.state.phase).toBe("transcribing")
  instance.controller.cancel()
  finish("wrong conversation")
  await Promise.resolve()
  expect(inserted).toEqual([])
  expect(media.stopped()).toBe(1)
  instance.dispose()
})
