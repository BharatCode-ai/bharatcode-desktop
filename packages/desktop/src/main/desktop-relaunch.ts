import { BRANDING } from "./branding"
import { isBharatCodeAuthCallback } from "./bharatcode-auth"

export function desktopRelaunchArgs(argv: readonly string[], pendingDeepLinks: readonly string[]) {
  const protocolPrefix = `${BRANDING.protocol}://`
  // Runtime switching cancels sign-in; never replay OAuth credentials in argv.
  return [
    ...argv.slice(1).filter((arg) => !arg.startsWith(protocolPrefix)),
    ...pendingDeepLinks.filter((url) => url.startsWith(protocolPrefix) && !isBharatCodeAuthCallback(url)),
  ]
}
