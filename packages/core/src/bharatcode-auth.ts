// This is the staged cutover default. Publish native candidates only together
// with Auth/API issuer activation; never probe or fall back to another issuer.
export const DEFAULT_ISSUER = "https://auth.bharatcode.ai/auth/v1"

export type Environment = Readonly<Record<string, string | undefined>>

export const configurationMessage =
  "Invalid BharatCode auth endpoint. Set BHARATCODE_AUTH_URL (or OPENCODE_AUTH_URL) to an HTTPS origin or a loopback HTTP origin, optionally ending in /auth/v1."

/** One endpoint policy for the native account service and Desktop's browser allowlist. */
export function issuer(env: Environment = process.env) {
  const input = env.BHARATCODE_AUTH_URL ?? env.OPENCODE_AUTH_URL ?? DEFAULT_ISSUER
  // Reject URL parser repairs (whitespace, backslashes, dot segments), not just
  // the normalized result. An explicit but broken override must never fall back.
  if (!/^https?:\/\/[^/?#\\\s]+(?:\/(?:auth\/v1\/?)?)?$/.test(input)) throw new Error(configurationMessage)
  const url = URL.parse(input)
  if (
    !url ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error(configurationMessage)
  }
  return `${url.origin}/auth/v1`
}

export * as BharatCodeAuth from "./bharatcode-auth"
