export type ModelRecoveryResult = "restored" | "unavailable" | "signInIncomplete" | "failed"

// Checking a connection must never replay a prompt, a tool, or a file edit.
export async function checkModelConnection(input: {
  signIn?: () => Promise<{ authenticated: boolean; state: string }>
  loadModels: () => Promise<string[]>
  modelID?: string
  current: () => boolean
}): Promise<ModelRecoveryResult | undefined> {
  try {
    if (!input.current()) return
    if (input.signIn) {
      const status = await input.signIn()
      if (!input.current()) return
      if (!status.authenticated || status.state !== "signed_in") return "signInIncomplete"
    }
    const models = await input.loadModels()
    if (!input.current()) return
    return (input.modelID ? models.includes(input.modelID) : models.length > 0) ? "restored" : "unavailable"
  } catch {
    if (input.current()) return "failed"
  }
}
