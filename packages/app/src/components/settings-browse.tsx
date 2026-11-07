import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"

export function SettingsBrowse(props: { v2?: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const [state, setState] = createStore<{
    busy: boolean
    status: "idle" | "pairing" | "connected" | "unavailable" | "failed" | "waiting" | "conflict"
    pairing?: { code: string; folder: string }
  }>({ busy: false, status: "idle" })

  async function run(action: "setup" | "check") {
    if (state.busy || !platform.browseSetup) return
    const sdk = serverSDK()
    if (!ServerConnection.builtin(sdk.server)) return
    setState("busy", true)
    try {
      const result = await platform.browseSetup(action)
      if (result.state === "pairing") {
        setState({ status: "pairing", pairing: { code: result.code, folder: result.folder } })
        return
      }
      if (result.state !== "connected") {
        setState("status", result.state)
        return
      }
      const config = await sdk.client.global.config.get({ throwOnError: true })
      const previous = config.data?.mcp?.["bharatcode-browse"]
      const runtimeRoot = result.environment.OPENCODE_BROWSER_HOME.replace(/[\\/]relay$/, "")
      const previousPath = previous && "command" in previous ? previous.command[0] : undefined
      if (
        previous &&
        (!("type" in previous) ||
          previous.type !== "local" ||
          previous.environment?.OPENCODE_BROWSER_HOME !== result.environment.OPENCODE_BROWSER_HOME ||
          previous.command.length !== 2 ||
          previous.command[1] !== "mcp" ||
          !previousPath?.startsWith(runtimeRoot) ||
          !/^[\\/][a-f0-9]{64}[\\/]browse(?:\.exe)?$/.test(previousPath.slice(runtimeRoot.length)))
      ) {
        setState("status", "conflict")
        return
      }
      if (
        !previous ||
        previous.enabled === false ||
        previous.command.join("\0") !== result.command.join("\0") ||
        Object.entries(result.environment).some(([key, value]) => previous.environment?.[key] !== value)
      ) {
        await sdk.client.global.config.update(
          {
            config: {
              mcp: {
                "bharatcode-browse": {
                  type: "local",
                  command: result.command,
                  environment: result.environment,
                  enabled: true,
                  ...(!previous ? { timeout: 120_000 } : {}),
                },
              },
            },
          },
          { throwOnError: true },
        )
      }
      setState({ status: "connected", pairing: undefined })
    } catch {
      setState("status", "failed")
    } finally {
      setState("busy", false)
    }
  }

  const status = {
    idle: "settings.browse.description",
    pairing: "settings.browse.instructions",
    connected: "settings.browse.connected",
    unavailable: "settings.browse.unavailable",
    failed: "settings.browse.failed",
    waiting: "settings.browse.waiting",
    conflict: "settings.browse.conflict",
  } as const

  return (
    <Show when={platform.browseSetup && ServerConnection.builtin(serverSDK().server)}>
      <section class={props.v2 ? "settings-v2-section" : "flex flex-col gap-2"} data-component="settings-browse">
        <h3 class={props.v2 ? "settings-v2-section-title" : "text-14-medium text-text-strong"}>
          {language.t("settings.browse.title")}
        </h3>
        <p role="status" class="text-12-regular text-text-weak">
          {language.t(status[state.status])}
        </p>
        <Show when={state.pairing}>
          {(pairing) => (
            <div class="flex flex-col gap-2">
              <p class="text-12-regular text-text-weak break-all">
                {language.t("settings.browse.folder")} <code class="select-text">{pairing().folder}</code>
              </p>
              <p class="text-12-regular text-text-weak">
                {language.t("settings.browse.code")} <code class="select-text">{pairing().code}</code>
              </p>
              <div class="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void platform.revealPath?.(pairing().folder)}>
                  {language.t("settings.browse.reveal")}
                </Button>
                <Button variant="primary" disabled={state.busy} onClick={() => void run("check")}>
                  {language.t("settings.browse.check")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <div>
          <Button
            variant={state.pairing ? "secondary" : "primary"}
            disabled={state.busy}
            onClick={() => void run("setup")}
          >
            {language.t(
              state.busy
                ? "settings.browse.working"
                : state.pairing
                  ? "settings.browse.newCode"
                  : "settings.browse.title",
            )}
          </Button>
        </div>
      </section>
    </Show>
  )
}
