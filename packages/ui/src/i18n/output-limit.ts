/** Presentation only: preserve content and the normal session completion state. */
export function outputLimitKey(
  message: { finish?: string; error?: unknown },
  parts: readonly { type: string; text?: string; state?: { status: string } }[],
) {
  if (message.finish !== "length" || message.error) return
  if (parts.some((part) => part.type === "tool" && ["pending", "running"].includes(part.state?.status ?? "")))
    return "ui.message.outputLimit.tool" as const
  if (parts.some((part) => part.type === "text" && part.text?.trim())) return "ui.message.outputLimit.partial" as const
  if (
    !parts.some((part) => part.type === "tool") &&
    parts.some((part) => part.type === "reasoning" && part.text?.trim())
  )
    return "ui.message.outputLimit.reasoning" as const
  return "ui.message.outputLimit" as const
}
