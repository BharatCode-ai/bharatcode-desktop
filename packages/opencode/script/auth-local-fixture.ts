/** Synthetic-only consent driver shared by the native acceptance harnesses. */
export async function approveLocalFixture(input: { issuer: string; url: string; file: string; redirectUri: string }) {
  const origin = new URL(input.issuer).origin
  const host = new URL(origin).hostname
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && !host.endsWith(".localhost")) {
    throw new Error("The consent driver only accepts a local Auth fixture.")
  }
  const fixture = (await Bun.file(input.file)
    .json()
    .catch(() => {
      throw new Error("The synthetic fixture file could not be read as JSON.")
    })) as {
    password?: string
    authOrigin?: string
    userId?: string
  }
  if (!fixture.password || !fixture.userId || fixture.authOrigin !== origin || new URL(input.url).origin !== origin) {
    throw new Error("Synthetic fixture configuration does not match the selected local Auth origin.")
  }
  const json = async (pathname: string, init: RequestInit) => {
    const response = await fetch(`${input.issuer}${pathname}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Local fixture ${pathname.split("?")[0]} failed (${response.status}).`)
    return (await response.json()) as Record<string, unknown>
  }
  const session = await json("/token?grant_type=password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.BHARATCODE_AUTH_FIXTURE_EMAIL ?? "auth-test@rehearsal.invalid",
      password: fixture.password,
    }),
  })
  if (
    typeof session.access_token !== "string" ||
    !session.user ||
    typeof session.user !== "object" ||
    !("id" in session.user) ||
    session.user.id !== fixture.userId
  ) {
    throw new Error("Local fixture password sign-in did not return the expected synthetic user.")
  }
  const authorization = await fetch(input.url, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
  const location = authorization.headers.get("location")
  if (authorization.status !== 302 || !location) throw new Error("Local fixture did not redirect to consent.")
  const consent = new URL(location)
  const id = consent.searchParams.get("authorization_id")
  if (consent.origin !== origin || !id) throw new Error("Local fixture returned invalid consent routing.")
  const headers = { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" }
  const details = await json(`/oauth/authorizations/${encodeURIComponent(id)}`, { headers })
  const approved =
    typeof details.redirect_url === "string"
      ? details
      : await json(`/oauth/authorizations/${encodeURIComponent(id)}/consent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "approve" }),
        })
  if (typeof approved.redirect_url !== "string") throw new Error("Local fixture did not issue a callback.")
  const callback = new URL(approved.redirect_url)
  const expected = new URL(input.redirectUri)
  if (
    callback.protocol !== expected.protocol ||
    callback.host !== expected.host ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.searchParams.get("state") !== new URL(input.url).searchParams.get("state")
  ) {
    throw new Error("Local fixture returned an unexpected native callback.")
  }
  return callback.toString()
}
