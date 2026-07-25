import { describe, expect, test } from "bun:test"

import { recoveryCliFilename, recoveryCliPackageName, validateRecoveryCliHeader } from "./recovery-cli-contract"

function validPeHeader() {
  const bytes = new Uint8Array(128)
  bytes.set([0x4d, 0x5a])
  new DataView(bytes.buffer).setUint32(0x3c, 0x40, true)
  bytes.set([0x50, 0x45, 0x00, 0x00], 0x40)
  return bytes
}

describe("recovery CLI packaging contract", () => {
  test("uses the fixed installed filename on every desktop platform", () => {
    expect(recoveryCliFilename("win32")).toBe("bharatcode-opencode-cli.exe")
    expect(recoveryCliFilename("darwin")).toBe("bharatcode-opencode-cli")
    expect(recoveryCliFilename("linux")).toBe("bharatcode-opencode-cli")
    expect(() => recoveryCliFilename("aix")).toThrow("Unsupported recovery CLI platform")
  })

  test("selects only the ordinary host-native build for the platform and architecture", () => {
    expect(recoveryCliPackageName("win32", "x64")).toBe("bharatcode-windows-x64")
    expect(recoveryCliPackageName("darwin", "x64")).toBe("bharatcode-darwin-x64")
    expect(recoveryCliPackageName("linux", "x64")).toBe("bharatcode-linux-x64")
    expect(recoveryCliPackageName("win32", "arm64")).toBe("bharatcode-windows-arm64")
    expect(recoveryCliPackageName("darwin", "arm64")).toBe("bharatcode-darwin-arm64")
    expect(recoveryCliPackageName("linux", "arm64")).toBe("bharatcode-linux-arm64")
    expect(() => recoveryCliPackageName("linux", "ia32")).toThrow("Unsupported recovery CLI architecture")
  })

  test("accepts only the native executable header for each platform", () => {
    expect(() => validateRecoveryCliHeader("win32", validPeHeader())).not.toThrow()
    expect(() => validateRecoveryCliHeader("darwin", Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("linux", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).not.toThrow()
    for (const bytes of [
      Uint8Array.from([0x4d, 0x5a]),
      (() => {
        const value = validPeHeader()
        new DataView(value.buffer).setUint32(0x3c, value.length, true)
        return value
      })(),
      (() => {
        const value = validPeHeader()
        value.set([0x4e, 0x4f, 0x50, 0x45], 0x40)
        return value
      })(),
    ]) {
      expect(() => validateRecoveryCliHeader("win32", bytes)).toThrow("invalid Windows PE header")
    }
    expect(() => validateRecoveryCliHeader("darwin", Uint8Array.from([0x4d, 0x5a]))).toThrow(
      "invalid macOS Mach-O header",
    )
    expect(() => validateRecoveryCliHeader("linux", Uint8Array.from([0x4d, 0x5a]))).toThrow("invalid Linux ELF header")
  })
})
