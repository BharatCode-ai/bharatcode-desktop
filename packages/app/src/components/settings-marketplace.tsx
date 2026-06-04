import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createSignal, For, Show, type Component } from "solid-js"

import { useCapabilities } from "@/context/capabilities"
import { useLanguage } from "@/context/language"
import type {
  CapabilityCatalogItem,
  CapabilityCategory,
  CapabilityInstallRecord,
  CapabilityPermission,
} from "@/context/platform"
import { SettingsList } from "./settings-list"

type ViewMode = "browse" | "installed"

const permissionCopy: Record<CapabilityPermission, string> = {
  workspace_files: "settings.marketplace.permission.workspace_files",
  local_process: "settings.marketplace.permission.local_process",
  browser_automation: "settings.marketplace.permission.browser_automation",
  oauth_account: "settings.marketplace.permission.oauth_account",
  network: "settings.marketplace.permission.network",
  env_vars: "settings.marketplace.permission.env_vars",
  background_process: "settings.marketplace.permission.background_process",
  billing_data: "settings.marketplace.permission.billing_data",
  database_data: "settings.marketplace.permission.database_data",
  deployment_data: "settings.marketplace.permission.deployment_data",
  monitoring_data: "settings.marketplace.permission.monitoring_data",
}

const statusCopy: Record<CapabilityInstallRecord["status"] | "available", string> = {
  available: "settings.marketplace.status.available",
  installed: "settings.marketplace.status.installed",
  enabled: "settings.marketplace.status.enabled",
  needs_setup: "settings.marketplace.status.needs_setup",
  unhealthy: "settings.marketplace.status.unhealthy",
  update_available: "settings.marketplace.status.update_available",
}

const categoryCopy: Record<CapabilityCategory, string> = {
  workflow: "settings.marketplace.category.workflow",
  "code-hosting": "settings.marketplace.category.code-hosting",
  browser: "settings.marketplace.category.browser",
  design: "settings.marketplace.category.design",
  planning: "settings.marketplace.category.planning",
  monitoring: "settings.marketplace.category.monitoring",
  database: "settings.marketplace.category.database",
  billing: "settings.marketplace.category.billing",
  docs: "settings.marketplace.category.docs",
}

function capabilityMatches(item: CapabilityCatalogItem, query: string) {
  const text = [item.name, item.description, item.publisher, item.category].join(" ").toLowerCase()
  return text.includes(query.trim().toLowerCase())
}

export const SettingsMarketplace: Component = () => {
  const language = useLanguage()
  const capabilities = useCapabilities()
  const [mode, setMode] = createSignal<ViewMode>("browse")
  const [query, setQuery] = createSignal("")
  const [selectedId, setSelectedId] = createSignal<string | undefined>("superpowers-obra")
  const [pendingId, setPendingId] = createSignal<string | undefined>()

  const snapshot = () => capabilities.snapshot()
  const installed = (id: string) => snapshot().state.installed[id]
  const status = (id: string) => installed(id)?.status ?? "available"
  const isInstalled = (id: string) => Boolean(installed(id))
  const health = (id: string) => {
    const record = installed(id)
    if (!record) return language.t("settings.marketplace.health.available")
    if (!record.enabled) return language.t("settings.marketplace.health.disabled")
    if (!record.health) return language.t("settings.marketplace.health.notChecked")
    return record.health.ok
      ? language.t("settings.marketplace.health.ok")
      : (record.health.message ?? language.t("settings.marketplace.health.issue"))
  }
  const visible = createMemo(() => {
    const list = snapshot().catalog.filter((item) => (mode() === "installed" ? isInstalled(item.id) : true))
    const q = query()
    return q.trim() ? list.filter((item) => capabilityMatches(item, q)) : list
  })
  const selected = createMemo(() => snapshot().catalog.find((item) => item.id === selectedId()) ?? visible()[0])

  const run = async (id: string, action: () => Promise<unknown>) => {
    setPendingId(id)
    try {
      await action()
    } finally {
      setPendingId(undefined)
    }
  }

  const install = (item: CapabilityCatalogItem) =>
    run(item.id, async () => {
      await capabilities.install(item.id)
      setSelectedId(item.id)
    })

  const setEnabled = (item: CapabilityCatalogItem, enabled: boolean) =>
    run(item.id, async () => {
      await capabilities.setEnabled(item.id, enabled)
      if (enabled && item.requiresSetup) {
        showToast({
          title: language.t("settings.marketplace.setup.toast.title"),
          description: language.t("settings.marketplace.setup.toast.description"),
        })
      }
    })

  const uninstall = (item: CapabilityCatalogItem) =>
    run(item.id, async () => {
      await capabilities.uninstall(item.id)
    })

  const configure = (item: CapabilityCatalogItem) => {
    showToast({
      title: language.t("settings.marketplace.configure.toast.title", { capability: item.name }),
      description: language.t("settings.marketplace.configure.toast.description"),
    })
  }

  const ActionButtons = (props: { item: CapabilityCatalogItem }) => {
    const item = () => props.item
    const record = () => installed(item().id)
    const pending = () => pendingId() === item().id
    return (
      <div class="flex items-center gap-2">
        <Show
          when={record()}
          fallback={
            <Button
              size="small"
              variant="secondary"
              disabled={pending()}
              onClick={() => void install(item())}
            >
              {language.t("settings.marketplace.action.install")}
            </Button>
          }
        >
          {(current) => (
            <>
              <Switch
                checked={current().enabled}
                disabled={pending()}
                onChange={(checked) => void setEnabled(item(), checked)}
              />
              <Show when={current().status === "needs_setup" || current().status === "unhealthy"}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={pending()}
                  onClick={() => configure(item())}
                >
                  {language.t("settings.marketplace.action.configure")}
                </Button>
              </Show>
              <Show when={item().trust !== "bundled"}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={pending()}
                  onClick={() => void uninstall(item())}
                >
                  {language.t("settings.marketplace.action.uninstall")}
                </Button>
              </Show>
            </>
          )}
        </Show>
      </div>
    )
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex max-w-[960px] flex-col gap-4 pt-6 pb-8">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-col gap-1">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.marketplace.title")}</h2>
              <p class="text-12-regular text-text-weak">{language.t("settings.marketplace.description")}</p>
            </div>
            <div class="flex items-center gap-1 rounded-lg bg-surface-base p-1">
              <button
                type="button"
                class="rounded-md px-3 py-1.5 text-12-medium transition-colors"
                classList={{
                  "bg-surface-raised-base text-text-strong": mode() === "browse",
                  "text-text-weak hover:text-text-base": mode() !== "browse",
                }}
                onClick={() => setMode("browse")}
              >
                {language.t("settings.marketplace.tab.browse")}
              </button>
              <button
                type="button"
                class="rounded-md px-3 py-1.5 text-12-medium transition-colors"
                classList={{
                  "bg-surface-raised-base text-text-strong": mode() === "installed",
                  "text-text-weak hover:text-text-base": mode() !== "installed",
                }}
                onClick={() => setMode("installed")}
              >
                {language.t("settings.marketplace.tab.installed")}
              </button>
            </div>
          </div>
          <TextField
            hideLabel
            label={language.t("settings.marketplace.search")}
            placeholder={language.t("settings.marketplace.search")}
            value={query()}
            onChange={setQuery}
          />
        </div>
      </div>

      <div class="grid max-w-[960px] grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <SettingsList>
          <Show
            when={visible().length > 0}
            fallback={<div class="py-4 text-14-regular text-text-weak">{language.t("settings.marketplace.empty")}</div>}
          >
            <For each={visible()}>
              {(item) => (
                <div
                  role="button"
                  tabIndex={0}
                  class="flex w-full cursor-default items-center justify-between gap-4 border-b border-border-weak-base py-3 text-left outline-none last:border-none focus-visible:bg-surface-raised-base-hover"
                  onClick={() => setSelectedId(item.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    setSelectedId(item.id)
                  }}
                >
                  <div class="flex min-w-0 items-start gap-3">
                    <div class="mt-0.5 text-icon-weak">
                      <Icon name={item.id === "github" ? "github" : "mcp"} />
                    </div>
                    <div class="flex min-w-0 flex-col gap-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-14-medium text-text-strong">{item.name}</span>
                        <Tag>{language.t(statusCopy[status(item.id)])}</Tag>
                        <Tag>{language.t(categoryCopy[item.category])}</Tag>
                        <Show when={item.trust === "bundled"}>
                          <Tag>{language.t("settings.marketplace.trust.bundled")}</Tag>
                        </Show>
                      </div>
                      <span class="truncate text-11-regular text-text-weaker">
                        {language.t("settings.marketplace.meta", {
                          publisher: item.publisher,
                          health: health(item.id),
                        })}
                      </span>
                      <span class="text-12-regular text-text-weak">{item.description}</span>
                    </div>
                  </div>
                  <div onClick={(event) => event.stopPropagation()}>
                    <ActionButtons item={item} />
                  </div>
                </div>
              )}
            </For>
          </Show>
        </SettingsList>

        <Show when={selected()}>
          {(item) => (
            <div class="flex flex-col gap-4 rounded-lg bg-surface-base p-4">
              <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-14-medium text-text-strong">{item().name}</h3>
                  <Tag>{language.t(statusCopy[status(item().id)])}</Tag>
                </div>
                <p class="text-11-regular text-text-weaker">
                  {language.t("settings.marketplace.detail.meta", {
                    publisher: item().publisher,
                    category: language.t(categoryCopy[item().category]),
                    version: item().version,
                    health: health(item().id),
                  })}
                </p>
                <p class="text-12-regular text-text-weak">{item().description}</p>
              </div>

              <div class="flex flex-col gap-2">
                <h4 class="text-12-medium text-text-base">{language.t("settings.marketplace.detail.modules")}</h4>
                <For each={item().modules}>
                  {(module) => (
                    <div class="text-12-regular text-text-weak">
                      {module.type === "skill" ? language.t("settings.marketplace.module.skill") : null}
                      {module.type === "mcp" ? language.t("settings.marketplace.module.mcp", { name: module.name }) : null}
                      {module.type === "connector"
                        ? language.t("settings.marketplace.module.connector", { name: module.name })
                        : null}
                      {module.type === "prompt"
                        ? language.t("settings.marketplace.module.prompt", { name: module.name })
                        : null}
                      {module.type === "surface"
                        ? language.t("settings.marketplace.module.surface", { name: module.name })
                        : null}
                    </div>
                  )}
                </For>
              </div>

              <div class="flex flex-col gap-2">
                <h4 class="text-12-medium text-text-base">{language.t("settings.marketplace.detail.permissions")}</h4>
                <For each={item().permissions}>
                  {(permission) => (
                    <div class="text-12-regular text-text-weak">{language.t(permissionCopy[permission])}</div>
                  )}
                </For>
              </div>

              <Show when={item().requirements.length > 0}>
                <div class="flex flex-col gap-2">
                  <h4 class="text-12-medium text-text-base">{language.t("settings.marketplace.detail.requirements")}</h4>
                  <For each={item().requirements}>
                    {(requirement) => <div class="text-12-regular text-text-weak">{requirement}</div>}
                  </For>
                </div>
              </Show>

              <ActionButtons item={item()} />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
