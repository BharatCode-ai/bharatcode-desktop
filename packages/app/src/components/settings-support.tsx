import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"

export function createSupportExportController(action: () => Promise<string>) {
  const [state, setState] = createStore<{ status: "idle" | "saving" | "saved" | "failed" }>({ status: "idle" })
  return {
    state,
    async run() {
      if (state.status === "saving") return
      setState("status", "saving")
      await Promise.resolve()
        .then(action)
        .then(
          () => setState("status", "saved"),
          () => setState("status", "failed"),
        )
    },
  }
}

export function SettingsSupport(props: { v2?: boolean }) {
  const platform = usePlatform()
  const language = useLanguage()
  const controller = createSupportExportController(() => platform.exportDebugLogs!())
  const label = () =>
    language.t(controller.state.status === "saving" ? "settings.support.saving" : "settings.support.export")
  return (
    <Show when={platform.platform === "desktop" && typeof platform.exportDebugLogs === "function"}>
      <section class={props.v2 ? "settings-v2-section" : "flex flex-col gap-2"} data-component="settings-support">
        <h3 class={props.v2 ? "settings-v2-section-title" : "text-14-medium text-text-strong"}>
          {language.t("settings.support.title")}
        </h3>
        <div class="flex flex-wrap items-center justify-between gap-4">
          <p class="text-12-regular text-text-weak flex-1">{language.t("settings.support.description")}</p>
          <Show
            when={props.v2}
            fallback={
              <Button
                variant="secondary"
                disabled={controller.state.status === "saving"}
                onClick={() => void controller.run()}
              >
                {label()}
              </Button>
            }
          >
            <ButtonV2
              variant="neutral"
              disabled={controller.state.status === "saving"}
              onClick={() => void controller.run()}
            >
              {label()}
            </ButtonV2>
          </Show>
        </div>
        <p role="status" aria-live="polite" class="text-12-regular text-text-weak">
          <Show when={controller.state.status === "saved"}>{language.t("settings.support.saved")}</Show>
          <Show when={controller.state.status === "failed"}>{language.t("desktop.support.error.export")}</Show>
        </p>
      </section>
    </Show>
  )
}
