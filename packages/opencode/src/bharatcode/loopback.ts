import { createServer, type Server } from "node:http"
import { CLI_REDIRECT_URI } from "./account"

export type Session = {
  callback: Promise<string>
  close: () => void
}

export type Options = {
  expectedState: string
  timeoutMs?: number
}

function page(title: string, message: string) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body>`
}

export async function start(options: Options): Promise<Session> {
  const redirect = new URL(CLI_REDIRECT_URI)
  let server: Server
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let resolveCallback!: (url: string) => void
  let rejectCallback!: (error: Error) => void

  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const close = () => {
    if (timer) clearTimeout(timer)
    if (server?.listening) server.close()
  }

  const settle = (result: { url: string } | { error: Error }) => {
    if (settled) return
    settled = true
    close()
    if ("url" in result) resolveCallback(result.url)
    else rejectCallback(result.error)
  }

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", CLI_REDIRECT_URI)
    if (url.pathname !== redirect.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end("Not found")
      return
    }
    if (url.searchParams.get("state") !== options.expectedState) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
      response.end(page("BharatCode authorization failed", "The authorization state did not match. Try again."))
      return
    }
    if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
      response.end(page("BharatCode authorization failed", "The callback did not include an authorization result."))
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(page("BharatCode authorization received", "Return to BharatCode to finish signing in."))
    settle({ url: url.toString() })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: NodeJS.ErrnoException) => {
      server.off("listening", onListening)
      close()
      const message =
        cause.code === "EADDRINUSE"
          ? "BharatCode sign-in is already running in another CLI process. Finish or close it, then try again."
          : "BharatCode could not start its local sign-in callback."
      reject(new Error(message, { cause }))
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(Number(redirect.port), redirect.hostname)
  })

  timer = setTimeout(
    () => settle({ error: new Error("BharatCode sign-in timed out. Start sign-in again.") }),
    options.timeoutMs ?? 180_000,
  )
  timer.unref?.()
  return { callback, close }
}

export * as BharatCodeLoopback from "./loopback"
