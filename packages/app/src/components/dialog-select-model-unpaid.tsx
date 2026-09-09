import { Dialog } from "@opencode-ai/ui/dialog"
import type { Component } from "solid-js"

export const DialogSelectModelUnpaid: Component<{ model?: unknown }> = () => (
  <Dialog title="BharatCode models unavailable">
    <div class="px-3 pb-6 text-14-regular text-text-base">
      No eligible live coding models are available for this BharatCode account. Refresh Account settings or try again
      later.
    </div>
  </Dialog>
)
