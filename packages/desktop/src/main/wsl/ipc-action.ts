import { nativeT } from "../native-translations"

type SenderEvent = {
  sender: { id: number; mainFrame: unknown; isDestroyed(): boolean }
  senderFrame: unknown
}

export function wslIpcAction<E extends SenderEvent, A extends unknown[], R>(
  run: (event: E, ...args: A) => R,
  owned: (id: number) => boolean,
) {
  return async (event: E, ...args: A) => {
    if (event.sender.isDestroyed() || !owned(event.sender.id) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error(nativeT("desktop.wsl.error.sender"))
    }
    try {
      return await run(event, ...args)
    } catch {
      // Renderer errors must not contain command lines, environment values or
      // raw child-process output. Status fields carry supported fixed outcomes.
      throw new Error(nativeT("desktop.wsl.error.request"))
    }
  }
}
