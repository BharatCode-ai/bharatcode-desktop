import { createEffect, For, on, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsList } from "./settings-list"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"
import { createMarketplaceController } from "./marketplace-controller"

export function SettingsMarketplace(props: { v2?: boolean }) {
  return (
    <SettingsServerScope>
      <MarketplaceContent v2={props.v2} />
    </SettingsServerScope>
  )
}

function Action(props: {
  v2?: boolean
  disabled?: boolean
  label?: string
  onClick: () => void
  children: JSX.Element
}) {
  return (
    <Show
      when={props.v2}
      fallback={
        <Button
          size="small"
          variant="secondary"
          disabled={props.disabled}
          aria-label={props.label}
          onClick={props.onClick}
        >
          {props.children}
        </Button>
      }
    >
      <ButtonV2
        size="small"
        variant="outline"
        disabled={props.disabled}
        aria-label={props.label}
        onClick={props.onClick}
      >
        {props.children}
      </ButtonV2>
    </Show>
  )
}

function MarketplaceContent(props: { v2?: boolean }) {
  const runtime = useServerSDK()
  const language = useLanguage()
  const [view, setView] = createStore({ confirmReload: false })
  const controller = createMarketplaceController({
    scope: runtime,
    read: async (scope, signal) => (await scope.client.v2.capabilities.get({ signal, throwOnError: true })).data,
    change: async (scope, id, action, signal) =>
      (
        await scope.client.v2.capabilities.change(
          { id, bharatCodeCapabilityChange: { action } },
          { signal, throwOnError: true },
        )
      ).data.state,
    reload: (scope, signal) => scope.client.global.dispose({ signal, throwOnError: true }),
  })
  createEffect(
    on(runtime, () => {
      setView("confirmReload", false)
      void controller.refresh()
    }),
  )
  const disabled = () => !!controller.state.busy || controller.state.uncertain
  const List = props.v2 ? SettingsListV2 : SettingsList
  return (
    <div
      class={props.v2 ? "flex flex-col h-full" : "flex flex-col h-full overflow-y-auto px-4 pb-10 sm:px-10"}
      data-component="settings-marketplace"
      aria-busy={!!controller.state.busy}
    >
      <div class={props.v2 ? "settings-v2-tab-header" : "pt-6 pb-8"}>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class={props.v2 ? "settings-v2-tab-title" : "text-16-medium text-text-strong"}>
            {language.t("marketplace.title")}
          </h2>
          <SettingsServerPicker />
        </div>
      </div>
      <div class={props.v2 ? "settings-v2-tab-body" : "flex flex-col gap-6 max-w-[720px]"}>
        <div class="flex flex-col gap-3">
          <p class="text-13-regular text-text-base">{language.t("marketplace.scope")}</p>
          <div class="flex flex-wrap gap-2">
            <Action v2={props.v2} disabled={!!controller.state.busy} onClick={() => void controller.refresh()}>
              {language.t(controller.state.busy === "refresh" ? "marketplace.refreshing" : "marketplace.refresh")}
            </Action>
            <Action
              v2={props.v2}
              disabled={disabled() || !controller.state.snapshot}
              onClick={() => setView("confirmReload", true)}
            >
              {language.t("marketplace.reload")}
            </Action>
          </div>
          <Show when={controller.state.error}>
            {(error) => (
              <p role="alert" class="text-13-regular text-text-strong">
                {language.t(`marketplace.error.${error()}`)}
              </p>
            )}
          </Show>
          <Show when={controller.state.reloadRequired && !controller.state.uncertain}>
            <p role="status" class="text-13-regular text-text-base">
              {language.t("marketplace.saved")}
            </p>
          </Show>
          <Show when={view.confirmReload}>
            <div class="flex flex-col gap-2">
              <p class="text-13-regular text-text-base">{language.t("marketplace.reloadWarning")}</p>
              <div class="flex flex-wrap gap-2">
                <Action
                  v2={props.v2}
                  disabled={disabled()}
                  onClick={() => {
                    setView("confirmReload", false)
                    void controller.reload()
                  }}
                >
                  {language.t("marketplace.reloadNow")}
                </Action>
                <Action v2={props.v2} onClick={() => setView("confirmReload", false)}>
                  {language.t("common.cancel")}
                </Action>
              </div>
            </div>
          </Show>
        </div>
        <Show
          when={controller.state.snapshot}
          fallback={
            <p role="status" class="text-13-regular text-text-base">
              {language.t(controller.state.busy ? "marketplace.loading" : "marketplace.unavailable")}
            </p>
          }
        >
          {(snapshot) => (
            <Show
              when={snapshot().catalog.length}
              fallback={<p class="text-13-regular text-text-base">{language.t("marketplace.empty")}</p>}
            >
              <List>
                <For each={snapshot().catalog}>
                  {(item) => {
                    const installed = () => controller.state.snapshot?.state.installed[item.id]
                    const primary = () => (!installed() ? "install" : installed()!.enabled ? "disable" : "enable")
                    return (
                      <section
                        class="flex flex-wrap justify-between gap-4 py-4 border-b border-border-weak-base last:border-none"
                        aria-label={item.name}
                      >
                        <div class="flex-1 min-w-[160px] flex flex-col gap-1.5">
                          <h3 class="text-14-medium text-text-strong break-words">{item.name}</h3>
                          <p class="text-12-regular text-text-base">
                            {item.publisher} ·{" "}
                            {language.t(
                              !installed()
                                ? "marketplace.available"
                                : installed()!.enabled
                                  ? "marketplace.enabled"
                                  : "marketplace.disabled",
                            )}
                          </p>
                          <p class="text-13-regular text-text-base break-words">{item.description}</p>
                          <Show when={item.requiresSetup && installed()?.enabled}>
                            <p class="text-12-regular text-text-base">{language.t("marketplace.setupNote")}</p>
                          </Show>
                          <Show when={item.requirements.length}>
                            <details class="text-12-regular text-text-base">
                              <summary class="cursor-pointer hover:text-text-strong focus-visible:outline-2">
                                {language.t("marketplace.requirements")}
                              </summary>
                              <ul class="list-disc ps-4 pt-1">
                                <For each={item.requirements}>{(requirement) => <li>{requirement}</li>}</For>
                              </ul>
                            </details>
                          </Show>
                        </div>
                        <div class="flex flex-wrap items-start gap-2">
                          <Action
                            v2={props.v2}
                            disabled={disabled()}
                            label={language.t(`marketplace.${primary()}Name`, { name: item.name })}
                            onClick={() => void controller.change(item.id, primary())}
                          >
                            {language.t(`marketplace.${primary()}`)}
                          </Action>
                          <Show when={installed() && item.trust !== "bundled"}>
                            <Action
                              v2={props.v2}
                              disabled={disabled()}
                              label={language.t("marketplace.removeName", { name: item.name })}
                              onClick={() => void controller.change(item.id, "uninstall")}
                            >
                              {language.t("marketplace.remove")}
                            </Action>
                          </Show>
                        </div>
                      </section>
                    )
                  }}
                </For>
              </List>
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
