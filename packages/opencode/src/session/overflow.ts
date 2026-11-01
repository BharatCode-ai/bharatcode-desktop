import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
// Room for one truncation-capped tool result (tool_output.max_bytes, 51200 bytes ~ 13k tokens)
// plus framing, so a large file read on the next step cannot push the request past the window.
const COMPACTION_HEADROOM = 16_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  // One margin, subtracted from whichever limit the model publishes. Reserving less than the
  // output allowance would leave no room for the reply, and splitting the two cases previously
  // made an input-capped model compact later than an identical model without an input cap.
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.max(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return Math.max(0, (input.model.limit.input || context) - reserved)
}

export function threshold(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const limit = usable(input)
  // An explicit reserve is the caller's own call on how much to hold back; don't quietly add to it.
  if (input.cfg.compaction?.reserved !== undefined) return limit
  // A budget this small has nothing to spare, and driving the threshold to zero would make every
  // turn look overflowing and compact in a loop.
  if (limit <= COMPACTION_HEADROOM * 2) return limit
  return limit - COMPACTION_HEADROOM
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= threshold(input)
}
