import { BRANDING } from "./branding"

type Backend<T> = {
  setFeedURL(options: { provider: "generic"; url: string; channel: string; useMultipleRangeRequests: boolean }): void
  checkForUpdates(): Promise<T>
}

const unavailable = () => new Error("Desktop update feed unavailable")
const base = `${BRANDING.repo.url}/releases/download/`

/** Resolve the namespaced Desktop beta, never the repository's CLI release. */
export async function checkDesktopBetaUpdate<T extends { updateInfo?: { version?: string } } | null | undefined>(
  backend: Backend<T>,
  request: typeof fetch = fetch,
) {
  const response = await request(
    `https://api.github.com/repos/${BRANDING.repo.owner}/${BRANDING.repo.name}/releases?per_page=100`,
    {
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  )
  if (!response.ok) throw unavailable()
  const releases: unknown = await response.json()
  if (!Array.isArray(releases)) throw unavailable()
  const candidates = releases.flatMap((release) => {
    if (!release || typeof release !== "object" || release.draft !== false || release.prerelease !== true) return []
    if (typeof release.tag_name !== "string") return []
    const match = /^desktop-beta-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name)
    if (!match) return []
    const parts = match[1].split(".").map(Number)
    if (!parts.every(Number.isSafeInteger)) return []
    return [{ version: match[1], parts, tag: release.tag_name }]
  })
  candidates.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2])
  const latest = candidates[0]
  // Do not silently fall back to an unrelated release or report up-to-date.
  if (!latest) throw unavailable()
  backend.setFeedURL({
    provider: "generic",
    url: `${base}${latest.tag}/`,
    channel: "beta",
    useMultipleRangeRequests: false,
  })
  const result = await backend.checkForUpdates()
  if (result && result.updateInfo?.version !== latest.version) throw unavailable()
  return result
}
