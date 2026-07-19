import { createResource, type JSX } from "solid-js"

import type { BharatCodeAccountStatus } from "@/context/platform"

type SafeStatus = Pick<BharatCodeAccountStatus, "state">

export function titlebarAccountView(status?: SafeStatus) {
  if (!status) return { state: "checking" as const, tone: "muted" as const, action: "none" as const }
  if (status.state === "signed_in") return { state: status.state, tone: "success" as const, action: "open" as const }
  if (status.state === "connection_issue")
    return { state: status.state, tone: "danger" as const, action: "refresh" as const }
  if (status.state === "needs_sign_in")
    return { state: status.state, tone: "warning" as const, action: "sign_in" as const }
  if (["authorizing", "refreshing", "switching"].includes(status.state))
    return { state: status.state, tone: "muted" as const, action: "none" as const }
  return { state: status.state, tone: "muted" as const, action: "sign_in" as const }
}

export function TitlebarAccountButton(props: {
  variant: "legacy" | "v2"
  label: string
  getStatus: () => Promise<BharatCodeAccountStatus>
  refresh: () => Promise<BharatCodeAccountStatus>
  signIn: (options?: { selectAccount?: boolean }) => Promise<BharatCodeAccountStatus>
  onOpen: () => void
  children?: JSX.Element
}) {
  const [status, { mutate }] = createResource(props.getStatus)
  const view = () => titlebarAccountView(status())

  const act = async () => {
    if (view().action === "open") return props.onOpen()
    if (view().action === "refresh") return mutate(await props.refresh())
    if (view().action === "sign_in") {
      mutate(await props.signIn())
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        const next = await props.getStatus()
        mutate(next)
        if (!["authorizing", "switching"].includes(next.state)) return
      }
    }
  }

  return (
    <button
      type="button"
      class="titlebar-icon size-6 rounded-full p-0 box-border shrink-0"
      classList={{
        "text-icon-success": view().tone === "success",
        "text-icon-warning": view().tone === "warning",
        "text-icon-danger": view().tone === "danger",
        "text-icon-base": view().tone === "muted",
      }}
      data-account-variant={props.variant}
      data-account-state={view().state}
      aria-label={`${props.label}: ${view().state}`}
      disabled={view().action === "none"}
      onClick={() => void act()}
    >
      {props.children ?? <span aria-hidden="true">●</span>}
    </button>
  )
}
