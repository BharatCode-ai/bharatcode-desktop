import { describe, expect, test } from "bun:test"

import { resolveDesktopStartupChatDirectory, startupChatPath } from "./app-startup"

describe("desktop startup chat routing", () => {
  test("opens the first available project directly to the chat route", () => {
    const directory = resolveDesktopStartupChatDirectory({
      platform: "desktop",
      ready: true,
      projects: [{ worktree: "/home/user/project" }],
      lastProject: undefined,
      home: "/home/user",
    })

    expect(directory).toBe("/home/user/project")
    expect(startupChatPath(directory!)).toBe("/L2hvbWUvdXNlci9wcm9qZWN0/session")
  })

  test("opens the last used project when it is still available", () => {
    expect(
      resolveDesktopStartupChatDirectory({
        platform: "desktop",
        ready: true,
        projects: [{ worktree: "/home/user/older" }, { worktree: "/home/user/latest" }],
        lastProject: "/home/user/latest",
        home: "/home/user",
      }),
    ).toBe("/home/user/latest")
  })

  test("falls back to the home folder when no project is open", () => {
    expect(
      resolveDesktopStartupChatDirectory({
        platform: "desktop",
        ready: true,
        projects: [],
        lastProject: undefined,
        home: "/home/user",
      }),
    ).toBe("/home/user")
  })

  test("does not use the filesystem root as the default project", () => {
    expect(
      resolveDesktopStartupChatDirectory({
        platform: "desktop",
        ready: true,
        projects: [],
        lastProject: undefined,
        home: "/",
      }),
    ).toBeUndefined()
  })

  test("reopens the last used project when no project list is hydrated yet", () => {
    expect(
      resolveDesktopStartupChatDirectory({
        platform: "desktop",
        ready: true,
        projects: [],
        lastProject: "/home/user/latest",
        home: "/home/user",
      }),
    ).toBe("/home/user/latest")
  })

  test("keeps the project picker on web and while startup data is loading", () => {
    expect(
      resolveDesktopStartupChatDirectory({
        platform: "web",
        ready: true,
        projects: [{ worktree: "/home/user/project" }],
        lastProject: "/home/user/project",
        home: "/home/user",
      }),
    ).toBeUndefined()
    expect(
      resolveDesktopStartupChatDirectory({
        platform: "desktop",
        ready: false,
        projects: [{ worktree: "/home/user/project" }],
        lastProject: "/home/user/project",
        home: "/home/user",
      }),
    ).toBeUndefined()
  })
})
