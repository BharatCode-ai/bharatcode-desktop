import type { Part as PartType } from "@opencode-ai/sdk/v2"

const HIDDEN_TOOLS = new Set(["todowrite", "mcp_goal_set", "mcp_goal_complete", "mcp_goal_blocker"])

export function isHiddenTool(tool: string) {
  return HIDDEN_TOOLS.has(tool)
}

export function renderable(
  part: PartType,
  showReasoningSummaries = true,
  hasPartComponent: (type: string) => boolean = () => false,
) {
  if (part.type === "tool") {
    if (isHiddenTool(part.tool)) return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return hasPartComponent(part.type)
}
