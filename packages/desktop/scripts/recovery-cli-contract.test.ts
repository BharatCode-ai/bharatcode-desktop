import { describe, expect, test } from "bun:test"

import { recoveryCliFilename, validateRecoveryCliHeader } from "./recovery-cli-contract"

describe("recovery CLI packaging contract", () => {
  test("uses the fixed installed filename on every desktop platform", () => {
    expect(recoveryCliFilename("win32")).toBe("bharatcode-opencode-cli.exe")
    expect(recoveryCliFilename("darwin")).toBe("bharatcode-opencode-cli")
    expect(recoveryCliFilename("linux")).toBe("bharatcode-opencode-cli")
    expect(() => recoveryCliFilename("aix")).toThrow("Unsupported recovery CLI platform")
  })

  test("accepts only the native executable header for each platform", () => {
    expect(() => validateRecoveryCliHeader("win32", Uint8Array.from([0x4d, 0x5a]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("darwin", Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("linux", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).not.toThrow()
    expect(() => validateRecoveryCliHeader("win32", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).toThrow(
      "invalid Windows PE header",
    )
    expect(() => validateRecoveryCliHeader("darwin", Uint8Array.from([0x4d, 0x5a]))).toThrow(
      "invalid macOS Mach-O header",
    )
    expect(() => validateRecoveryCliHeader("linux", Uint8Array.from([0x4d, 0x5a]))).toThrow("invalid Linux ELF header")
  })
})
