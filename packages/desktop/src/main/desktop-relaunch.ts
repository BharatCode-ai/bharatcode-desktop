import { BRANDING } from "./branding"

export function desktopRelaunchArgs(argv: readonly string[], pendingDeepLinks: readonly string[]) {
  const protocolPrefix = `${BRANDING.protocol}://`
  return [...argv.slice(1).filter((arg) => !arg.startsWith(protocolPrefix)), ...pendingDeepLinks]
}
