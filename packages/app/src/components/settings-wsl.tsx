import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { Show, createResource, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import {
  usePlatform,
  type Platform,
  type WslConfigurationUpdate,
  type WslSnapshot,
  type WslStatus,
} from "@/context/platform"
import { SettingsList } from "./settings-list"

export function wslSettingsVisible(platform: Pick<Platform, "platform" | "os" | "getWslSnapshot">): boolean {
  return platform.platform === "desktop" && platform.os === "windows" && typeof platform.getWslSnapshot === "function"
}

export function wslEnableUpdate(snapshot: WslSnapshot, enabled: boolean): WslConfigurationUpdate {
  if (!enabled) return { enabled: false, expectedRevision: snapshot.revision }
  const selectedDisplayName =
    snapshot.selectedDisplayName ??
    snapshot.distributions.find((distribution) => distribution.version === 2)?.displayName
  if (!selectedDisplayName) throw new Error("No WSL2 distribution is available")
  return { enabled: true, expectedRevision: snapshot.revision, selectedDisplayName }
}

export function wslCanEnable(snapshot: WslSnapshot): boolean {
  return snapshot.enabled || snapshot.distributions.length > 0
}

export async function runWslStatusAction(
  action: () => Promise<WslSnapshot | undefined> | WslSnapshot | null | undefined,
  hooks: {
    setBusy: (busy: boolean) => void
    onResult: (snapshot: WslSnapshot) => void
    onError: (error: unknown) => void
  },
): Promise<void> {
  hooks.setBusy(true)
  try {
    const result = await action()
    if (result) hooks.onResult(result)
  } catch (error) {
    hooks.onError(error)
  } finally {
    hooks.setBusy(false)
  }
}

export function wslSelectUpdate(snapshot: WslSnapshot, selectedDisplayName: string): WslConfigurationUpdate {
  if (!snapshot.distributions.some((distribution) => distribution.displayName === selectedDisplayName)) {
    throw new Error("The selected WSL2 distribution is unavailable")
  }
  return { enabled: true, expectedRevision: snapshot.revision, selectedDisplayName }
}

export function wslStatusText(status: WslStatus): string {
  if (status.phase === "error") return `Error: ${status.code}`
  return `${status.phase.slice(0, 1).toUpperCase()}${status.phase.slice(1)}`
}

export function wslRecoveryActions(status: WslStatus): Array<"choose" | "retry" | "disable"> {
  if (status.phase !== "error") return []
  return ["choose", "retry", "disable"]
}

function SettingsRow(props: { title: string; description?: string; children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <Show when={props.description}>
          {(description) => <span class="text-12-regular text-text-weak">{description()}</span>}
        </Show>
      </div>
      <div class="flex items-center gap-2 shrink-0">{props.children}</div>
    </div>
  )
}

export const SettingsWsl: Component = () => {
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false })
  const [snapshot, { mutate, refetch }] = createResource(() => platform.getWslSnapshot?.())

  const reportError = (title: string, error: unknown) => {
    showToast({
      variant: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    })
  }

  const run = (title: string, action: () => Promise<WslSnapshot | undefined> | WslSnapshot | null | undefined) =>
    runWslStatusAction(action, {
      setBusy: (busy) => setState("busy", busy),
      onResult: mutate,
      onError: (error) => reportError(title, error),
    })

  async function apply(update: WslConfigurationUpdate) {
    if (!platform.configureWsl) return
    await run("Could not update WSL", () => platform.configureWsl!(update))
  }

  async function retry() {
    if (!platform.retryWsl) return
    await run("Could not retry WSL", () => platform.retryWsl!())
  }

  async function refresh() {
    await run("Could not refresh WSL", () => refetch())
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="pt-8 pb-6">
        <h2 class="text-16-medium text-text-strong">{language.t("settings.desktop.wsl.title")}</h2>
        <p class="text-13-regular text-text-weak mt-1">{language.t("settings.desktop.wsl.description")}</p>
      </div>
      <SettingsList>
        <SettingsRow title="Enable WSL" description="Run BharatCode inside the selected WSL2 distribution.">
          <Switch
            checked={snapshot()?.enabled ?? false}
            disabled={state.busy || !snapshot() || !wslCanEnable(snapshot()!)}
            onChange={(enabled) => {
              const current = snapshot()
              if (!current || (enabled && !wslCanEnable(current))) return
              try {
                void apply(wslEnableUpdate(current, enabled))
              } catch (error) {
                reportError("Could not update WSL", error)
              }
            }}
          />
        </SettingsRow>
        <SettingsRow title="Distribution" description="Only installed WSL2 distributions are available.">
          <select
            data-action="settings-wsl-distribution"
            class="text-13-regular bg-surface-raised-base border border-border-weak-base rounded px-2 py-1"
            value={snapshot()?.selectedDisplayName ?? ""}
            disabled={state.busy || !snapshot()}
            onChange={(event) => {
              const current = snapshot()
              if (!current || !event.currentTarget.value) return
              void apply(wslSelectUpdate(current, event.currentTarget.value))
            }}
          >
            <option value="" disabled>
              Select WSL2 distribution
            </option>
            {snapshot()?.distributions.map((distribution) => (
              <option value={distribution.displayName}>{distribution.displayName}</option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow title="Status" description={snapshot() ? wslStatusText(snapshot()!.status) : "Checking"}>
          <div class="flex gap-2">
            <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void refresh()}>
              Refresh
            </Button>
            <Show when={snapshot()?.status.phase === "error"}>
              <Button
                size="small"
                variant="secondary"
                disabled={state.busy}
                onClick={() =>
                  document.querySelector<HTMLSelectElement>('[data-action="settings-wsl-distribution"]')?.focus()
                }
              >
                Choose
              </Button>
              <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void retry()}>
                Retry
              </Button>
              <Button
                size="small"
                variant="secondary"
                disabled={state.busy}
                onClick={() => {
                  const current = snapshot()
                  if (current) void apply(wslEnableUpdate(current, false))
                }}
              >
                Disable
              </Button>
            </Show>
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )
}
