import { describe, expect, test } from "bun:test"
import { isTransientNotaryStatusError } from "../../electron-builder.config"

describe("macOS notarization", () => {
  test("classifies transient status polling network failures", () => {
    expect(
      isTransientNotaryStatusError(
        new Error(
          'Command failed: xcrun notarytool info submission-id\nError Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline." UserInfo={_NSURLErrorNWPathKey=unsatisfied (No network route)}',
        ),
      ),
    ).toBe(true)
  })

  test("does not hide auth or submission failures as transient", () => {
    expect(isTransientNotaryStatusError(new Error("Authentication failed. Invalid issuer id."))).toBe(false)
    expect(isTransientNotaryStatusError(new Error("Apple notarization rejected submission submission-id"))).toBe(false)
  })
})
