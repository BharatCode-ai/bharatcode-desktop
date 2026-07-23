import { describe, expect, test } from "bun:test"
import { desktopRelaunchArgs } from "./desktop-relaunch"

describe("desktop relaunch arguments", () => {
  test("preserves inherited non-protocol arguments including the development app path", () => {
    expect(
      desktopRelaunchArgs(
        ["C:\\Program Files\\BharatCode\\BharatCode.exe", "C:\\dev\\bharatcode\\packages\\desktop", "--profile=beta"],
        [],
      ),
    ).toEqual(["C:\\dev\\bharatcode\\packages\\desktop", "--profile=beta"])
  })

  test("does not replay a consumed initial BharatCode callback", () => {
    expect(
      desktopRelaunchArgs(
        [
          "C:\\Program Files\\BharatCode\\BharatCode.exe",
          "C:\\dev\\bharatcode\\packages\\desktop",
          "bharatcode://auth/callback?code=consumed",
          "--profile=beta",
        ],
        [],
      ),
    ).toEqual(["C:\\dev\\bharatcode\\packages\\desktop", "--profile=beta"])
  })

  test("appends only pending links exactly once and in queue order", () => {
    const pending = ["bharatcode://auth/callback?code=pending", "bharatcode://project/open?path=C%3A%5Cdev%5Cproject"]
    expect(
      desktopRelaunchArgs(
        ["C:\\Program Files\\BharatCode\\BharatCode.exe", "--profile=beta", "bharatcode://auth/callback?code=consumed"],
        pending,
      ),
    ).toEqual(["--profile=beta", ...pending])
  })

  test("does not remove unrelated URL schemes", () => {
    expect(
      desktopRelaunchArgs(
        [
          "C:\\Program Files\\BharatCode\\BharatCode.exe",
          "https://bharatcode.com/auth/callback",
          "opencode://project/open",
        ],
        [],
      ),
    ).toEqual(["https://bharatcode.com/auth/callback", "opencode://project/open"])
  })

  test("controlled relaunch composes explicit sanitized arguments before exit", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()
    const relaunch = source.indexOf("async function relaunchDesktop()")
    const argumentsCall = source.indexOf(
      "app.relaunch({ args: desktopRelaunchArgs(process.argv, pendingIncomingDeepLinks) })",
      relaunch,
    )
    const exit = source.indexOf("app.exit(0)", relaunch)

    expect(source).toContain('import { desktopRelaunchArgs } from "./desktop-relaunch"')
    expect(argumentsCall).toBeGreaterThan(relaunch)
    expect(exit).toBeGreaterThan(argumentsCall)
  })
})
