import { createAccountStatusResource, useLanguage } from "@opencode-ai/app"
import { Button } from "@opencode-ai/ui/button"
import { Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export function BharatCodeAuthGate(props: ParentProps) {
  const language = useLanguage()
  const [auth, { mutate, refetch }] = createAccountStatusResource(window.api)
  const [store, setStore] = createStore({ signingIn: false, failed: false })
  const ready = () => auth()?.authenticated === true
  const pending = () => store.signingIn || ["authorizing", "switching", "refreshing"].includes(auth()?.state ?? "")
  async function signIn() {
    if (pending()) return
    setStore({ signingIn: true, failed: false })
    try {
      mutate(await window.api.beginSignIn())
      if (!ready()) setStore("failed", true)
    } catch {
      setStore("failed", true)
    } finally {
      setStore("signingIn", false)
    }
  }
  async function cancel() {
    try {
      await window.api.cancelSignIn()
    } catch {
      setStore("failed", true)
    }
  }
  return (
    <Show
      when={ready()}
      fallback={
        <main class="min-h-screen w-full bg-background-base text-text-strong flex items-center justify-center px-6">
          <section class="w-full max-w-md flex flex-col gap-5" aria-busy={pending()}>
            <div class="flex flex-col gap-2">
              <h1 class="text-28-bold">BharatCode</h1>
              <p class="text-14-regular text-text-base">{language.t("account.gate.description")}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                type="button"
                size="large"
                variant="primary"
                disabled={auth.loading || pending()}
                onClick={() => void signIn()}
              >
                {pending() ? language.t("settings.account.action.signingIn") : language.t("account.gate.continue")}
              </Button>
              <Show when={pending()}>
                <Button type="button" size="large" variant="secondary" onClick={() => void cancel()}>
                  {language.t("common.cancel")}
                </Button>
              </Show>
              <Show when={!pending() && (store.failed || auth()?.state === "connection_issue")}>
                <Button
                  type="button"
                  size="large"
                  variant="secondary"
                  disabled={auth.loading}
                  onClick={() => {
                    setStore("failed", false)
                    void refetch()
                  }}
                >
                  {language.t("settings.account.action.refresh")}
                </Button>
              </Show>
            </div>
            <Show when={store.failed || auth()?.state === "connection_issue" || auth()?.state === "needs_sign_in"}>
              <p role="alert" class="text-14-regular text-text-danger-base">
                {language.t(
                  auth()?.state === "connection_issue" ? "account.gate.unavailable" : "desktop.account.error.complete",
                )}
              </p>
            </Show>
            <p class="text-12-regular text-text-weak">{language.t("account.gate.browser")}</p>
          </section>
        </main>
      }
    >
      {props.children}
    </Show>
  )
}
