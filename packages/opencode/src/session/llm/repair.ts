import { modelMessageSchema, type ModelMessage } from "ai"

// Last-resort guard before the AI SDK sees the prompt. streamText validates the
// whole message list and rejects the turn outright if any single message fails
// ("Invalid prompt: The messages do not match the ModelMessage[] schema"), which
// leaves the session unusable because every later turn replays the same history.
// Repair invalid messages instead, and report where they were wrong so the
// source of the malformed history can be fixed.

export type Issue = { index: number; role: string; path: string; action: "repaired" | "dropped" }

const valid = (msg: unknown) => modelMessageSchema.safeParse(msg).success

function issuePath(msg: unknown) {
  const result = modelMessageSchema.safeParse(msg)
  if (result.success) return ""
  // Report every candidate path: a union failure lists one per branch.
  return [...new Set(result.error.issues.map((issue) => issue.path.join(".")))].slice(0, 5).join(" | ")
}

// Drops undefined and non-JSON values, removes provider metadata (the usual
// offender: it must be a record of records), and nulls in optional fields.
function scrub(msg: ModelMessage): ModelMessage {
  const plain = JSON.parse(JSON.stringify(msg)) as Record<string, any>
  delete plain.providerOptions
  if (Array.isArray(plain.content)) {
    plain.content = plain.content
      .filter((part: unknown) => part && typeof part === "object")
      .map((part: Record<string, any>) => {
        const { providerOptions: _, ...rest } = part
        return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null))
      })
  }
  return plain as ModelMessage
}

function repairOne(msg: ModelMessage): ModelMessage | undefined {
  const scrubbed = scrub(msg)
  if (valid(scrubbed)) return scrubbed
  if (!Array.isArray(scrubbed.content)) return
  // Keep whichever parts are individually valid.
  const content = (scrubbed.content as any[]).filter((part) => valid({ ...scrubbed, content: [part] }))
  if (content.length === 0) return
  const kept = { ...scrubbed, content } as ModelMessage
  return valid(kept) ? kept : undefined
}

export function repairMessages(messages: ModelMessage[]): { messages: ModelMessage[]; issues: Issue[] } {
  if (modelMessageSchema.array().safeParse(messages).success) return { messages, issues: [] }

  const issues: Issue[] = []
  const repaired: ModelMessage[] = []
  for (const [index, msg] of messages.entries()) {
    if (valid(msg)) {
      repaired.push(msg)
      continue
    }
    const path = issuePath(msg)
    const role = typeof (msg as any)?.role === "string" ? (msg as any).role : "unknown"
    const fixed = msg && typeof msg === "object" ? repairOne(msg) : undefined
    issues.push({ index, role, path, action: fixed ? "repaired" : "dropped" })
    if (fixed) repaired.push(fixed)
  }

  // A tool result whose call was dropped is rejected by providers; drop it too.
  const calls = new Set(
    repaired.flatMap((msg) =>
      msg.role === "assistant" && Array.isArray(msg.content)
        ? msg.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : []))
        : [],
    ),
  )
  const result = repaired.flatMap((msg): ModelMessage[] => {
    if (msg.role !== "tool") return [msg]
    const content = msg.content.filter((part) => part.type !== "tool-result" || calls.has(part.toolCallId))
    return content.length > 0 ? [{ ...msg, content }] : []
  })

  return { messages: result, issues }
}
