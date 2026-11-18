import { BRANDING } from "./branding"

type Backend<T> = {
  setFeedURL(options: { provider: "generic"; url: string; channel: string; useMultipleRangeRequests: boolean }): void
  checkForUpdates(): Promise<T>
}

const unavailable = () => new Error("Desktop update feed unavailable")
const base = `${BRANDING.repo.url}/releases/download/`
type Metadata = { version?: string; files?: readonly { url: string }[]; path?: string }

/** Only public, stable Desktop tags. Repository "latest" can be a CLI release. */
export async function checkDesktopStableUpdate<T extends { updateInfo?: Metadata } | null | undefined>(
  backend: Backend<T>,
  request: typeof fetch = fetch,
) {
  const endpoint = `https://api.github.com/repos/${BRANDING.repo.owner}/${BRANDING.repo.name}/releases?per_page=100`
  const signal = AbortSignal.timeout(15_000)
  const releases: unknown[] = []
  for (let page = 1; ; page++) {
    const response = await request(page === 1 ? endpoint : `${endpoint}&page=${page}`, {
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal,
      redirect: "error",
    })
    if (!response.ok) throw unavailable()
    const items: unknown = await response.json()
    if (!Array.isArray(items)) throw unavailable()
    releases.push(...items)
    if (!response.headers.get("link")?.includes('rel="next"')) break
  }
  const candidates = releases.flatMap((release) => {
    if (
      !release ||
      typeof release !== "object" ||
      !("draft" in release) ||
      release.draft !== false ||
      !("prerelease" in release) ||
      release.prerelease !== false
    )
      return []
    if (!("tag_name" in release) || typeof release.tag_name !== "string") return []
    const match = /^desktop-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name)
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
    channel: "latest",
    useMultipleRangeRequests: false,
  })
  const result = await backend.checkForUpdates()
  if (result) {
    const info = result.updateInfo
    // GenericProvider also accepts absolute URLs and NSIS web packages. Stable
    // metadata may only point at Desktop assets under the selected tag.
    if (
      !info ||
      info.version !== latest.version ||
      "packages" in info ||
      !Array.isArray(info.files) ||
      !info.files.length ||
      info.files.some(
        (file) =>
          typeof file?.url !== "string" ||
          !/^bharatcode-desktop-[a-zA-Z0-9_-]+\.(exe|zip|AppImage|deb)$/.test(file.url),
      ) ||
      (info.path !== undefined && !info.files.some((file) => file.url === info.path))
    )
      throw unavailable()
  }
  return result
}
