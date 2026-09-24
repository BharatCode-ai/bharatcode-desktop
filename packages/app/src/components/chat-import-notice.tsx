import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { usePlatform } from "../context/platform"
import { useLanguage } from "../context/language"

export function ChatImportNotice() {
  const platform = usePlatform()
  const language = useLanguage()
  const [status, setStatus] = createSignal<{ state: "pending" | "complete" | "failed"; imported: number }>()
  const [dismissed, dismiss] = createSignal(false)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
  })
  onMount(() => {
    if (!platform.getChatImportStatus) return
    const poll = async () => {
      const next = await platform.getChatImportStatus!().catch(() => ({ state: "failed" as const, imported: 0 }))
      if (disposed) return
      setStatus(next)
      if (next.state === "pending") timer = setTimeout(poll, 1000)
    }
    void poll()
  })
  return (
    <Show when={!dismissed() && status() && (status()!.state !== "complete" || status()!.imported > 0)}>
      <div
        role="status"
        class="flex flex-wrap items-center gap-3 border-b border-border-base bg-surface-base px-4 py-2 text-12-regular text-text-base"
      >
        <span class="flex-1">
          {status()?.state === "complete"
            ? language.t("chatImport.complete", { count: status()!.imported })
            : language.t(status()?.state === "failed" ? "chatImport.failed" : "chatImport.pending")}
        </span>
        <Show when={status()?.state === "complete"}>
          <Button size="small" variant="secondary" onClick={() => window.location.reload()}>
            {language.t("chatImport.refresh")}
          </Button>
        </Show>
        <Button size="small" variant="ghost" onClick={() => dismiss(true)}>
          {language.t("chatImport.dismiss")}
        </Button>
      </div>
    </Show>
  )
}
