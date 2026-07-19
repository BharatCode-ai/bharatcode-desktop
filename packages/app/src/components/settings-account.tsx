import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { createResource, Match, Show, Switch, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { type BharatCodeAccountStatus, type BharatCodeSignInOptions, usePlatform } from "@/context/platform"
import { SettingsList } from "./settings-list"

type AccountTone = "success" | "warning" | "danger" | "muted"
type AccountPrimaryAction = "sign_in" | "reconnect" | "refresh"
type AccountSignInIntent = "default" | "switch_account"
type AccountTitleKey =
  | "settings.account.state.checking.title"
  | "settings.account.state.signedOut.title"
  | "settings.account.state.signedIn.title"
  | "settings.account.state.needsSignIn.title"
  | "settings.account.state.connectionIssue.title"
type AccountDescriptionKey =
  | "settings.account.state.checking.description"
  | "settings.account.state.signedOut.description"
  | "settings.account.state.signedIn.description"
  | "settings.account.state.needsSignIn.description"
  | "settings.account.state.connectionIssue.description"
type AccountActionLabelKey =
  | "settings.account.action.signIn"
  | "settings.account.action.reconnect"
  | "settings.account.action.refresh"

export function accountStatusViewModel(status: BharatCodeAccountStatus | undefined): {
  titleKey: AccountTitleKey
  descriptionKey: AccountDescriptionKey
  tone: AccountTone
  primaryAction?: AccountPrimaryAction
} {
  if (!status) {
    return {
      titleKey: "settings.account.state.checking.title",
      descriptionKey: "settings.account.state.checking.description",
      tone: "muted",
    }
  }

  if (status.state === "signed_in") {
    return {
      titleKey: "settings.account.state.signedIn.title",
      descriptionKey: "settings.account.state.signedIn.description",
      tone: "success",
    }
  }

  if (status.state === "needs_sign_in") {
    return {
      titleKey: "settings.account.state.needsSignIn.title",
      descriptionKey: "settings.account.state.needsSignIn.description",
      tone: "warning",
      primaryAction: "reconnect",
    }
  }

  if (status.state === "connection_issue") {
    return {
      titleKey: "settings.account.state.connectionIssue.title",
      descriptionKey: "settings.account.state.connectionIssue.description",
      tone: "danger",
      primaryAction: "refresh",
    }
  }

  return {
    titleKey: "settings.account.state.signedOut.title",
    descriptionKey: "settings.account.state.signedOut.description",
    tone: "muted",
    primaryAction: "sign_in",
  }
}

export function accountPrimaryActionLabelKey(action: AccountPrimaryAction): AccountActionLabelKey {
  if (action === "sign_in") return "settings.account.action.signIn"
  if (action === "reconnect") return "settings.account.action.reconnect"
  return "settings.account.action.refresh"
}

export function accountSignInOptions(intent: AccountSignInIntent): BharatCodeSignInOptions {
  return intent === "switch_account" ? { selectAccount: true } : {}
}

function toneClass(tone: AccountTone) {
  if (tone === "success") return "bg-icon-success-base"
  if (tone === "warning") return "bg-icon-warning-base"
  if (tone === "danger") return "bg-icon-critical-base"
  return "bg-border-weak-base"
}

function formatTime(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString()
}

function AccountRow(props: { title: string; description?: string; children?: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <Show when={props.description}>
          {(description) => (
            <span class="text-12-regular text-text-weak break-words whitespace-pre-wrap">{description()}</span>
          )}
        </Show>
      </div>
      <Show when={props.children}>
        <div class="flex items-center gap-2 shrink-0">{props.children}</div>
      </Show>
    </div>
  )
}

export const SettingsAccount: Component = () => {
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore({
    signingIn: false,
    refreshing: false,
    exporting: false,
    loggingOut: false,
  })

  const [status, { mutate }] = createResource(() => platform.getAccountStatus?.())
  const view = () => accountStatusViewModel(status())

  async function refresh() {
    const action = platform.refreshAccountStatus ?? platform.getAccountStatus
    if (!action) return
    setStore("refreshing", true)
    try {
      mutate(await action())
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.account.toast.refreshFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStore("refreshing", false)
    }
  }

  async function signIn(intent: AccountSignInIntent = "default") {
    if (!platform.beginSignIn) return
    setStore("signingIn", true)
    try {
      mutate(await platform.beginSignIn(accountSignInOptions(intent)))
      const complete = platform.completeSignIn ?? platform.getAccountStatus
      if (complete) {
        for (let attempt = 0; attempt < 180; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          const next = await complete()
          mutate(next)
          if (!["authorizing", "switching"].includes(next.state)) break
        }
      }
      if (["authorizing", "switching"].includes(status()?.state ?? "")) {
        throw new Error("Timed out waiting for BharatCode sign-in. Try again.")
      }
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.account.toast.signedIn.title"),
        description: language.t("settings.account.toast.signedIn.description"),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.account.toast.signInFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStore("signingIn", false)
    }
  }

  async function logout() {
    if (!platform.logout) return
    setStore("loggingOut", true)
    try {
      mutate(await platform.logout())
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.account.toast.refreshFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStore("loggingOut", false)
    }
  }

  async function exportLogs() {
    if (!platform.exportDebugLogs) return
    setStore("exporting", true)
    try {
      await platform.exportDebugLogs()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.account.toast.exportFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStore("exporting", false)
    }
  }

  const checkedAt = () => formatTime(status()?.checkedAt)

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.account.title")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-4 rounded-md border border-border-weak-base bg-background-base p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-start gap-3 min-w-0">
              <span class={`mt-1 size-2.5 rounded-full shrink-0 ${toneClass(view().tone)}`} />
              <div class="flex flex-col gap-1 min-w-0">
                <h3 class="text-15-medium text-text-strong">{language.t(view().titleKey)}</h3>
                <p class="text-13-regular text-text-base">{language.t(view().descriptionKey)}</p>
              </div>
            </div>
            <Icon name="shield" class="size-5 text-icon-weak shrink-0" />
          </div>

          <div class="flex flex-wrap gap-2">
            <Switch>
              <Match when={view().primaryAction === "sign_in" || view().primaryAction === "reconnect"}>
                <Button
                  size="large"
                  variant="primary"
                  disabled={store.signingIn}
                  onClick={() => void signIn("default")}
                >
                  {store.signingIn
                    ? language.t("settings.account.action.signingIn")
                    : language.t(accountPrimaryActionLabelKey(view().primaryAction!))}
                </Button>
              </Match>
            </Switch>
            <Show when={view().tone === "success" && platform.beginSignIn}>
              <Button
                size="large"
                variant="secondary"
                disabled={store.signingIn}
                onClick={() => void signIn("switch_account")}
              >
                {store.signingIn
                  ? language.t("settings.account.action.signingIn")
                  : language.t("settings.account.action.useAnother")}
              </Button>
            </Show>
            <Button size="large" variant="secondary" disabled={store.refreshing} onClick={() => void refresh()}>
              {store.refreshing
                ? language.t("settings.account.action.refreshing")
                : language.t("settings.account.action.refresh")}
            </Button>
            <Show when={status()?.authenticated && platform.logout}>
              <Button size="large" variant="secondary" disabled={store.loggingOut} onClick={() => void logout()}>
                {store.loggingOut ? "Signing out..." : "Sign out"}
              </Button>
            </Show>
            <Show when={platform.exportDebugLogs}>
              <Button size="large" variant="ghost" disabled={store.exporting} onClick={() => void exportLogs()}>
                {store.exporting
                  ? language.t("settings.account.action.exporting")
                  : language.t("settings.account.action.exportLogs")}
              </Button>
            </Show>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.account.section.details")}</h3>
          <SettingsList>
            <AccountRow
              title={language.t("settings.account.row.account")}
              description={status()?.email ?? language.t("settings.account.value.notAvailable")}
            />
            <AccountRow
              title={language.t("settings.account.row.lastChecked")}
              description={checkedAt() ?? language.t("settings.account.value.notAvailable")}
            />
          </SettingsList>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.account.section.support")}</h3>
          <SettingsList>
            <AccountRow
              title={language.t("settings.account.row.diagnostics")}
              description={language.t("settings.account.row.diagnostics.description")}
            />
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
