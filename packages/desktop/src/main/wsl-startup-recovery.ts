import type { WslErrorCode } from "./wsl-contract"
import { WslLifecycleFailure } from "./wsl-lifecycle"

export type WslStartupRecoveryCode = WslErrorCode | "configuration-failed"
export type WslStartupRecoveryAction = "retry" | "disable-and-restart" | "quit"

export function projectWslStartupRecoveryCode(error: unknown): WslErrorCode {
  return error instanceof WslLifecycleFailure ? error.code : "start-failed"
}

export async function recoverWslStartup(options: {
  start: () => Promise<void>
  prompt: (code: WslStartupRecoveryCode) => Promise<WslStartupRecoveryAction>
  disableAndRestart: () => Promise<never>
  quit: () => Promise<never>
}): Promise<void> {
  let code: WslStartupRecoveryCode
  try {
    await options.start()
    return
  } catch (error) {
    code = projectWslStartupRecoveryCode(error)
  }

  while (true) {
    const action = await options.prompt(code)
    if (action === "retry") {
      try {
        await options.start()
        return
      } catch (error) {
        code = projectWslStartupRecoveryCode(error)
      }
      continue
    }
    if (action === "disable-and-restart") {
      try {
        return await options.disableAndRestart()
      } catch {
        code = "configuration-failed"
      }
      continue
    }
    return options.quit()
  }
}
