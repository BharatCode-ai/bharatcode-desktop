export type RecoveryCliPlatform = "win32" | "darwin" | "linux"

export function requireRecoveryCliPlatform(value: string): RecoveryCliPlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value
  throw new Error(`Unsupported recovery CLI platform: ${value}`)
}

export function recoveryCliFilename(value: string) {
  return requireRecoveryCliPlatform(value) === "win32" ? "bharatcode-opencode-cli.exe" : "bharatcode-opencode-cli"
}

export function validateRecoveryCliHeader(value: string, bytes: Uint8Array) {
  const platform = requireRecoveryCliPlatform(value)
  const expected =
    platform === "win32" ? [0x4d, 0x5a] : platform === "darwin" ? [0xcf, 0xfa, 0xed, 0xfe] : [0x7f, 0x45, 0x4c, 0x46]
  if (expected.every((byte, index) => bytes[index] === byte)) return
  const label = platform === "win32" ? "Windows PE" : platform === "darwin" ? "macOS Mach-O" : "Linux ELF"
  throw new Error(`Packaged recovery CLI has an invalid ${label} header`)
}
