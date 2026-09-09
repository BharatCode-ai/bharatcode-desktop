export type RecoveryCliPlatform = "win32" | "darwin" | "linux"

export function requireRecoveryCliPlatform(value: string): RecoveryCliPlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value
  throw new Error(`Unsupported recovery CLI platform: ${value}`)
}

export function recoveryCliFilename(value: string) {
  return requireRecoveryCliPlatform(value) === "win32" ? "bharatcode-opencode-cli.exe" : "bharatcode-opencode-cli"
}

export function recoveryCliPackageName(value: string, arch: string) {
  const platform = requireRecoveryCliPlatform(value)
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported recovery CLI architecture: ${arch}`)
  const os = platform === "win32" ? "windows" : platform
  return `bharatcode-${os}-${arch}`
}

export function validateRecoveryCliHeader(value: string, bytes: Uint8Array) {
  const platform = requireRecoveryCliPlatform(value)
  if (platform === "win32") {
    if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
      const peOffset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0x3c, true)
      if (
        peOffset <= bytes.length - 4 &&
        bytes[peOffset] === 0x50 &&
        bytes[peOffset + 1] === 0x45 &&
        bytes[peOffset + 2] === 0x00 &&
        bytes[peOffset + 3] === 0x00
      ) {
        return
      }
    }
  } else {
    const expected = platform === "darwin" ? [0xcf, 0xfa, 0xed, 0xfe] : [0x7f, 0x45, 0x4c, 0x46]
    if (expected.every((byte, index) => bytes[index] === byte)) return
  }
  const label = platform === "win32" ? "Windows PE" : platform === "darwin" ? "macOS Mach-O" : "Linux ELF"
  throw new Error(`Packaged recovery CLI has an invalid ${label} header`)
}
