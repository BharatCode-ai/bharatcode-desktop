import { createResource, onCleanup } from "solid-js"
import type { BharatCodeAccountStatus, Platform } from "./platform"
import { createAccountStatusTracker } from "./account-status-tracker"

// Every account surface observes the same main-owned revisions. In-flight reads
// and IPC replies cannot overwrite a newer callback/logout notification.
export function createAccountStatusResource(
  platform: Pick<Platform, "getAccountStatus" | "onAccountStatusChanged">,
  enabled: () => boolean = () => true,
) {
  const tracker = createAccountStatusTracker()
  const [status, actions] = createResource(
    () => enabled() && !!platform.getAccountStatus,
    async () => tracker.accept(await platform.getAccountStatus!()),
  )
  const mutate = (next: BharatCodeAccountStatus | undefined) => actions.mutate(tracker.accept(next))
  const unsubscribe = platform.onAccountStatusChanged?.(mutate)
  onCleanup(() => unsubscribe?.())
  return [status, { ...actions, mutate }] as const
}
