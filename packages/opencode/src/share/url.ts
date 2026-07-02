export const BHARATCODE_SHARE_BASE_URL = "https://bharatcode.ai"

const openCodeShareHosts = new Set([["opncd", "ai"].join("."), ["opencode", "ai"].join(".")])

export function normalizeBharatCodeShareBaseUrl(input: string) {
  const url = new URL(input)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("BharatCode share base URL must use http or https.")
  }
  const host = url.hostname.toLowerCase()
  if (openCodeShareHosts.has(host) || [...openCodeShareHosts].some((item) => host.endsWith(`.${item}`))) {
    throw new Error("BharatCode share base URL cannot point to OpenCode infrastructure.")
  }
  url.search = ""
  url.hash = ""
  const pathname = url.pathname.replace(/\/+$/, "")
  return pathname ? `${url.origin}${pathname}` : url.origin
}

export function getBharatCodeShareBaseUrl() {
  return normalizeBharatCodeShareBaseUrl(process.env.BHARATCODE_SHARE_BASE_URL?.trim() || BHARATCODE_SHARE_BASE_URL)
}

export function validateBharatCodeShareUrl(input: string, baseUrl = getBharatCodeShareBaseUrl()) {
  const url = new URL(input)
  const base = new URL(normalizeBharatCodeShareBaseUrl(baseUrl))
  const basePath = base.pathname.replace(/\/+$/, "")
  const expectedPath = `${basePath}/share/`
  if (url.origin !== base.origin || !url.pathname.startsWith(expectedPath)) {
    throw new Error("BharatCode share response returned an invalid public URL.")
  }
  return input
}

export function safeBharatCodeShareUrl(input: string | null | undefined, baseUrl?: string) {
  if (!input) return undefined
  try {
    return validateBharatCodeShareUrl(input, baseUrl)
  } catch {
    return undefined
  }
}
