import { isBharatCodeAuthCallback } from "./bharatcode-auth"

export function createDeepLinkEvents(options: {
  protocol: string
  pending: string[]
  client: () => { completeSignIn: (url: string) => Promise<unknown> } | undefined
  forward: (urls: string[]) => Promise<void>
  log: (
    event:
      | "desktop project link failed"
      | "desktop account callback failed"
      | "desktop second-instance link received"
      | "desktop open-url link received"
      | "desktop link dispatch failed",
  ) => void
}) {
  const dispatch = async (urls: string[]) => {
    await Promise.all(
      urls.map(async (url) => {
        try {
          if (!isBharatCodeAuthCallback(url)) {
            await options.forward([url]).catch(() => options.log("desktop project link failed"))
            return
          }
          const client = options.client()
          if (!client) {
            options.pending.push(url)
            return
          }
          await client.completeSignIn(url).catch(() => options.log("desktop account callback failed"))
        } catch {
          options.log("desktop link dispatch failed")
        }
      }),
    )
  }
  return {
    secondInstance: async (argv: string[]) => {
      const urls = argv.filter((arg) => arg.startsWith(`${options.protocol}://`))
      if (!urls.length) return
      options.log("desktop second-instance link received")
      await dispatch(urls)
    },
    openUrl: async (event: { preventDefault(): void }, url: string) => {
      event.preventDefault()
      options.log("desktop open-url link received")
      await dispatch([url])
    },
    flush: async () => dispatch(options.pending.splice(0)),
  }
}
