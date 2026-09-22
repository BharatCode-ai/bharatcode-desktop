import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { modelRecoveryAction } from "@opencode-ai/core/util/model-recovery"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { checkModelConnection, type ModelRecoveryResult } from "./model-recovery-check"

export function ModelRecovery(props: { message: string; modelID?: string; requestKey: string }) {
  const platform = usePlatform()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServerSDK()
  const [state, setState] = createStore({ busy: false, notice: undefined as ModelRecoveryResult | undefined })
  let generation = 0
  let active: AbortController | undefined
  let disposed = false
  createEffect(() => {
    sdk()
    server()
    props.requestKey
    props.message
    props.modelID
    generation++
    active?.abort()
    setState({ busy: false, notice: undefined })
  })
  onCleanup(() => {
    disposed = true
    generation++
    active?.abort()
  })

  async function recover(signIn: boolean) {
    if (state.busy) return
    const attempt = ++generation
    const context = sdk()
    const connection = server()
    const account = platform.accountForServer?.(ServerConnection.key(connection.server)) ?? platform
    const key = props.requestKey
    active = new AbortController()
    const abort = active
    const current = () =>
      !disposed && generation === attempt && sdk() === context && server() === connection && props.requestKey === key
    setState({ busy: true, notice: undefined })
    try {
      const notice = await checkModelConnection({
        signIn: signIn ? account.beginSignIn : undefined,
        modelID: props.modelID,
        current,
        loadModels: async () => {
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
          if ((await context.protocol) === "v1") {
            const result = await context.client.provider.list(undefined, { throwOnError: true, signal })
            return Object.keys(result.data.all.find((provider) => provider.id === "bharatcode")?.models ?? {})
          }
          const result = await connection.currentApi.model.list(
            { location: { directory: context.directory } },
            { signal },
          )
          return result.data.filter((model) => model.providerID === "bharatcode").map((model) => model.id)
        },
      })
      if (current()) setState("notice", notice)
    } finally {
      if (current()) setState("busy", false)
    }
  }

  return (
    <Show when={modelRecoveryAction(props.message)}>
      <div class="flex flex-col gap-2 mt-3" aria-busy={state.busy}>
        <div class="flex flex-wrap gap-2">
          <Show when={modelRecoveryAction(props.message) === "sign-in" && platform.beginSignIn}>
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={state.busy}
              onClick={() => void recover(true)}
            >
              {language.t("settings.account.action.signIn")}
            </Button>
          </Show>
          <Button
            type="button"
            size="small"
            variant="secondary"
            disabled={state.busy}
            onClick={() => void recover(false)}
          >
            {language.t(state.busy ? "model.recovery.checking" : "model.recovery.retry")}
          </Button>
        </div>
        <Show when={state.notice}>{(notice) => <p role="status">{language.t(`model.recovery.${notice()}`)}</p>}</Show>
      </div>
    </Show>
  )
}
