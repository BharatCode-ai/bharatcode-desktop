import { supportEvent, type SupportEvent } from "@opencode-ai/core/util/support-event"

// Process-local diagnostics only. No subscriber means no retention or disk writes.
const listeners = new Set<(event: SupportEvent) => void>()

export function subscribeSupportEvents(listener: (event: SupportEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function recordSupportEvent(input: Record<string, unknown>) {
  if (!listeners.size) return
  const event = supportEvent({ ...input, time: new Date().toISOString() })
  if (!event) return
  for (const listener of listeners) {
    // Diagnostics must never change request processing, even if the receiver fails.
    try {
      listener({ ...event })
    } catch {}
  }
}
