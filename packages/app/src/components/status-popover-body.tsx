import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useCapabilities } from "@/context/capabilities"
import { useLanguage } from "@/context/language"
import { usePlatform, type BharatCodeAccountStatus } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useCheckServerHealth, type ServerHealth } from "@/utils/server-health"
import { useQueryOptions } from "@/context/global-sync"
import { pathKey } from "@/utils/path-key"
import { accountStatusViewModel } from "./settings-account"

const pollMs = 10_000

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    url: undefined as string | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("url", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("url", next ? normalizeServerUrl(next) : undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("url", normalizeServerUrl(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      const u = state.url
      if (!u) return
      return ServerConnection.key({ type: "http", http: { url: u } })
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

const useMcpToggleMutation = () => {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()

  return useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = sync.data.mcp[name]
      if (status?.status === "connected") {
        await sdk.client.mcp.disconnect({ name })
        return
      }
      if (status?.status === "needs_auth") {
        await sdk.client.mcp.auth.authenticate({ name })
        return
      }
      await sdk.client.mcp.connect({ name })
    },
    onSuccess: () => queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory))),
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))
}

const accountIndicatorClass = (status: BharatCodeAccountStatus | undefined) => {
  const view = accountStatusViewModel(status)
  if (view.tone === "success") return "bg-icon-success-base"
  if (view.tone === "warning") return "bg-icon-warning-base"
  if (view.tone === "danger") return "bg-icon-critical-base"
  return "bg-border-weak-base"
}

export function StatusPopoverBody(props: { shown: Accessor<boolean> }) {
  const sync = useSync()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const capabilities = useCapabilities()

  createEffect(() => {
    if (!props.shown()) return
  })

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })
  const servers = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (list.every((item) => ServerConnection.key(item) !== ServerConnection.key(current))) return [current, ...list]
    return [current, ...list.filter((item) => ServerConnection.key(item) !== ServerConnection.key(current))]
  })
  const health = useServerHealth(servers, props.shown)
  const sortedServers = createMemo(() => listServersByHealth(servers(), server.key, health))
  const toggleMcp = useMcpToggleMutation()
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync.data.mcp?.[name]?.status
  const mcpConnected = createMemo(() => mcpNames().filter((name) => mcpStatus(name) === "connected").length)
  const lspItems = createMemo(() => sync.data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginCount = createMemo(() => plugins().length)
  const pluginEmpty = createMemo(() => language.t("dialog.plugins.empty"))
  const installedCapabilities = createMemo(() => Object.values(capabilities.snapshot().state.installed))
  const enabledCapabilities = createMemo(() => installedCapabilities().filter((item) => item.enabled).length)
  const setupCapabilities = createMemo(
    () => installedCapabilities().filter((item) => item.status === "needs_setup" || item.status === "unhealthy").length,
  )
  const [accountStatus, { mutate: mutateAccountStatus, refetch: refetchAccountStatus }] = createResource(
    () => props.shown() && !!platform.getBharatCodeAccountStatus,
    async (enabled) => {
      if (!enabled || !platform.getBharatCodeAccountStatus) return undefined
      return platform.getBharatCodeAccountStatus()
    },
  )

  const openMarketplace = () => {
    const run = ++dialogRun
    void import("./dialog-settings").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSettings defaultTab="marketplace" />)
    })
  }

  const openAccountSettings = () => {
    const run = ++dialogRun
    void import("./dialog-settings").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSettings defaultTab="account" />)
    })
  }

  const refreshAccountStatus = async () => {
    const action = platform.refreshBharatCodeAccountStatus ?? platform.getBharatCodeAccountStatus
    if (!action) return
    try {
      mutateAccountStatus(await action())
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.account.toast.refreshFailed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const signInToBharatCode = async () => {
    if (!platform.signInToBharatCode) return
    try {
      await platform.signInToBharatCode()
      await refetchAccountStatus()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.account.toast.signedIn.title"),
        description: language.t("settings.account.toast.signedIn.description"),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.account.toast.signInFailed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="tabs bg-background-strong rounded-xl overflow-hidden"
        data-component="tabs"
        data-active="servers"
        defaultValue="servers"
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
            {sortedServers().length > 0 ? `${sortedServers().length} ` : ""}
            {language.t("status.popover.tab.servers")}
          </Tabs.Trigger>
          <Show when={platform.getBharatCodeAccountStatus}>
            <Tabs.Trigger value="account" data-slot="tab" class="text-12-regular">
              {language.t("status.popover.tab.account")}
            </Tabs.Trigger>
          </Show>
          <Tabs.Trigger value="mcp" data-slot="tab" class="text-12-regular">
            {mcpConnected() > 0 ? `${mcpConnected()} ` : ""}
            {language.t("status.popover.tab.mcp")}
          </Tabs.Trigger>
          <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
            {lspCount() > 0 ? `${lspCount()} ` : ""}
            {language.t("status.popover.tab.lsp")}
          </Tabs.Trigger>
          <Tabs.Trigger value="plugins" data-slot="tab" class="text-12-regular">
            {pluginCount() > 0 ? `${pluginCount()} ` : ""}
            {language.t("status.popover.tab.plugins")}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="servers">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <For each={sortedServers()}>
                {(s) => {
                  const key = ServerConnection.key(s)
                  const blocked = () => health[key]?.healthy === false
                  return (
                    <button
                      type="button"
                      class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                      classList={{
                        "hover:bg-surface-raised-base-hover": !blocked(),
                        "cursor-not-allowed": blocked(),
                      }}
                      aria-disabled={blocked()}
                      onClick={() => {
                        if (blocked()) return
                        navigate("/")
                        queueMicrotask(() => server.setActive(key))
                      }}
                    >
                      <ServerHealthIndicator health={health[key]} />
                      <ServerRow
                        conn={s}
                        dimmed={blocked()}
                        status={health[key]}
                        class="flex items-center gap-2 w-full min-w-0"
                        nameClass="text-14-regular text-text-base truncate"
                        versionClass="text-12-regular text-text-weak truncate"
                        badge={
                          <Show when={key === defaultServer.key()}>
                            <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                              {language.t("common.default")}
                            </span>
                          </Show>
                        }
                      >
                        <div class="flex-1" />
                        <Show when={server.current && key === ServerConnection.key(server.current)}>
                          <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                        </Show>
                      </ServerRow>
                    </button>
                  )
                }}
              </For>

              <Button
                variant="secondary"
                class="mt-3 self-start h-8 px-3 py-1.5"
                onClick={() => {
                  const run = ++dialogRun
                  void import("./dialog-select-server").then((x) => {
                    if (dialogDead || dialogRun !== run) return
                    dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
                  })
                }}
              >
                {language.t("status.popover.action.manageServers")}
              </Button>
            </div>
          </div>
        </Tabs.Content>

        <Show when={platform.getBharatCodeAccountStatus}>
          <Tabs.Content value="account">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col gap-3 p-3 bg-background-base rounded-sm min-h-14">
                <div class="flex items-start gap-3 rounded-md bg-surface-base px-3 py-3">
                  <span class={`mt-1.5 size-2 rounded-full shrink-0 ${accountIndicatorClass(accountStatus())}`} />
                  <div class="flex min-w-0 flex-col gap-1">
                    <span class="text-13-medium text-text-base">
                      {language.t(accountStatusViewModel(accountStatus()).titleKey)}
                    </span>
                    <span class="text-12-regular text-text-weak">
                      {accountStatus()?.email ?? language.t(accountStatusViewModel(accountStatus()).descriptionKey)}
                    </span>
                    <Show when={accountStatus()?.connection && !accountStatus()?.connection?.ok}>
                      <span class="text-11-regular text-icon-warning-base">
                        {accountStatus()?.connection?.message ?? language.t("settings.account.value.connectionIssue")}
                      </span>
                    </Show>
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Show
                    when={
                      platform.signInToBharatCode &&
                      (accountStatus()?.state === "signed_out" || accountStatus()?.state === "needs_sign_in")
                    }
                  >
                    <Button variant="primary" class="h-8 px-3 py-1.5" onClick={() => void signInToBharatCode()}>
                      {language.t(
                        accountStatus()?.state === "signed_out"
                          ? "settings.account.action.signIn"
                          : "settings.account.action.reconnect",
                      )}
                    </Button>
                  </Show>
                  <Button variant="secondary" class="h-8 px-3 py-1.5" onClick={() => void refreshAccountStatus()}>
                    {language.t("settings.account.action.refresh")}
                  </Button>
                  <Button variant="secondary" class="h-8 px-3 py-1.5" onClick={openAccountSettings}>
                    {language.t("status.popover.action.manageAccount")}
                  </Button>
                </div>
              </div>
            </div>
          </Tabs.Content>
        </Show>

        <Tabs.Content value="mcp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col gap-3 p-3 bg-background-base rounded-sm min-h-14">
              <div class="flex items-center justify-between gap-3 rounded-md bg-surface-base px-3 py-2">
                <div class="flex min-w-0 flex-col">
                  <span class="text-12-medium text-text-base">{language.t("status.popover.capabilities.title")}</span>
                  <span class="text-11-regular text-text-weak">
                    {language.t("status.popover.capabilities.summary", {
                      enabled: enabledCapabilities(),
                      setup: setupCapabilities(),
                    })}
                  </span>
                </div>
                <Button variant="secondary" class="h-7 px-2 py-1" onClick={openMarketplace}>
                  {language.t("status.popover.action.manageMarketplace")}
                </Button>
              </div>
              <Show
                when={mcpNames().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.mcp.empty")}</div>
                }
              >
                <For each={mcpNames()}>
                  {(name) => {
                    const status = () => mcpStatus(name)
                    const enabled = () => status() === "connected"
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full min-h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                        onClick={() => {
                          if (toggleMcp.isPending) return
                          toggleMcp.mutate(name)
                        }}
                        disabled={toggleMcp.isPending && toggleMcp.variables === name}
                      >
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": status() === "connected",
                            "bg-icon-critical-base": status() === "failed",
                            "bg-border-weak-base": status() === "disabled",
                            "bg-icon-warning-base":
                              status() === "needs_auth" || status() === "needs_client_registration",
                          }}
                        />
                        <span class="flex flex-col min-w-0 flex-1">
                          <span class="flex items-center gap-2 min-w-0">
                            <span class="text-14-regular text-text-base truncate">{name}</span>
                          </span>
                          <Show when={status() === "needs_auth"}>
                            <span class="text-11-regular text-text-weaker truncate">
                              {language.t("mcp.auth.clickToAuthenticate")}
                            </span>
                          </Show>
                        </span>
                        <div onClick={(event) => event.stopPropagation()}>
                          <Switch
                            checked={enabled()}
                            disabled={toggleMcp.isPending && toggleMcp.variables === name}
                            onChange={() => {
                              if (toggleMcp.isPending) return
                              toggleMcp.mutate(name)
                            }}
                          />
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="lsp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={lspItems().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.lsp.empty")}</div>
                }
              >
                <For each={lspItems()}>
                  {(item) => (
                    <div class="flex items-center gap-2 w-full px-2 py-1">
                      <div
                        classList={{
                          "size-1.5 rounded-full shrink-0": true,
                          "bg-icon-success-base": item.status === "connected",
                          "bg-icon-critical-base": item.status === "error",
                        }}
                      />
                      <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="plugins">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={plugins().length > 0}
                fallback={<div class="text-14-regular text-text-base text-center my-auto">{pluginEmpty()}</div>}
              >
                <For each={plugins()}>
                  {(plugin) => (
                    <div class="flex items-center gap-2 w-full px-2 py-1">
                      <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                      <span class="text-14-regular text-text-base truncate">{plugin}</span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>
      </Tabs>
    </div>
  )
}
