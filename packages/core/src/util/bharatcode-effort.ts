export const bharatCodeGlmEfforts = ["low", "high"] as const

export function isBharatCodeGlm(provider: string, model: string) {
  return provider === "bharatcode" && (model === "glm-5.3-flash" || model === "qwen-3.8-27b")
}
