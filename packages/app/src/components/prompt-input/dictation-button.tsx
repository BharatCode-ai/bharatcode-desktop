import { Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { captureDictation, createDictationController } from "./dictation"

export function DictationButton(props: { sessionID?: string; disabled?: boolean; onInsert: (text: string) => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const command = useCommand()
  const [availability] = createResource(sdk, async (runtime) => {
    if ((await runtime.protocol) !== "v1") return undefined
    return runtime.client.v2.account
      .dictationStatus({ throwOnError: true, signal: AbortSignal.timeout(20_000) })
      .then(({ data }) => data)
      .catch(() => undefined)
  })
  const maxBytes = () => {
    const current = availability()
    return !availability.loading &&
      !props.disabled &&
      current?.available &&
      current.maxBytes &&
      Number.isFinite(current.maxBytes) &&
      current.maxBytes > 0
      ? Math.min(current.maxBytes, 16 * 1024 * 1024)
      : undefined
  }
  const scope = createMemo(() => ({ runtime: sdk(), session: props.sessionID, disabled: props.disabled }))
  const controller = createDictationController({
    scope,
    maxBytes,
    capture: captureDictation,
    async transcribe(blob, signal) {
      const runtime = sdk()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (signal.aborted) throw new Error("cancelled")
      const chunks: string[] = []
      for (let offset = 0; offset < bytes.length; offset += 8192)
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
      const { data } = await runtime.client.v2.account.dictation(
        {
          bharatCodeDictationRequest: { audio: btoa(chunks.join("")), mimeType: blob.type },
        },
        { throwOnError: true, signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]) },
      )
      return data.text
    },
    insert: props.onInsert,
  })
  const busy = () => controller.state.phase !== "idle"
  const toggle = () => (controller.state.phase === "recording" ? controller.stop() : void controller.start())
  command.register("dictation", () => [
    {
      id: "prompt.dictation",
      title: language.t("dictation.start"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+m",
      disabled: !maxBytes(),
      onSelect: toggle,
    },
  ])
  createEffect(() => {
    if (!busy()) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      controller.cancel()
    }
    document.addEventListener("keydown", cancel, true)
    onCleanup(() => document.removeEventListener("keydown", cancel, true))
  })
  const label = () =>
    language.t(
      controller.state.phase === "recording"
        ? "dictation.stop"
        : controller.state.phase === "transcribing"
          ? "dictation.transcribing"
          : controller.state.phase === "requesting"
            ? "dictation.requesting"
            : "dictation.start",
    )
  return (
    <Show when={maxBytes()}>
      <div class="relative flex items-center gap-1" aria-busy={busy()}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          data-action="prompt-dictation"
          disabled={controller.state.phase === "requesting" || controller.state.phase === "transcribing"}
          onPointerDown={(event: PointerEvent) => event.preventDefault()}
          onClick={toggle}
        >
          {label()}
        </Button>
        <Show when={busy()}>
          <Button type="button" variant="ghost" size="small" onClick={controller.cancel}>
            {language.t("common.cancel")}
          </Button>
        </Show>
        <Show when={controller.state.error}>
          {(error) => (
            <span
              role="alert"
              class="absolute bottom-full right-0 mb-2 w-64 rounded-md bg-surface-raised-stronger-non-alpha p-2 text-12-regular text-text-base"
            >
              {language.t(`dictation.error.${error()}`)}
            </span>
          )}
        </Show>
      </div>
    </Show>
  )
}
