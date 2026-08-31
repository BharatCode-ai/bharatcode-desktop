import { describe, expect, test } from "bun:test"

import {
  createStartupRestoreGuard,
  resolveDesktopStartupChatDirectory,
  resolveStartupSession,
  startupChatPath,
} from "./app-startup"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { readFileSync } from "node:fs"

const session = (id: string, directory = "/project", updated = 1): Session =>
  ({ id, directory, time: { created: updated, updated } }) as Session

describe("persisted startup conversation", () => {
  const saved = { id: "ses_saved", directory: "/project" }
  const input = () => ({
    root: "/project",
    directories: ["/project", "/worktree"],
    remembered: saved,
    get: async () => session("ses_saved"),
    list: async () => [session("ses_newer", "/project", 2)],
    worktrees: async () => [] as string[],
    current: () => true,
  })

  test("saved conversation wins over a newer conversation after a cold restart", async () => {
    expect((await resolveStartupSession(input()))?.id).toBe("ses_saved")
  })

  test("restores saved worktree context", async () => {
    expect(
      (
        await resolveStartupSession({
          ...input(),
          remembered: { ...saved, directory: "/worktree" },
          get: async () => session("ses_saved", "/worktree"),
        })
      )?.directory,
    ).toBe("/worktree")
  })

  test("a deleted saved conversation falls back to the latest visible root session", async () => {
    expect((await resolveStartupSession({ ...input(), get: async () => undefined }))?.id).toBe("ses_newer")
  })

  test("archived and child sessions are not chosen as fallback", async () => {
    const archived = { ...session("ses_archive"), time: { created: 3, updated: 3, archived: 4 } }
    const child = { ...session("ses_child"), parentID: "ses_parent" }
    expect(
      await resolveStartupSession({ ...input(), get: async () => archived, list: async () => [archived, child] }),
    ).toBeUndefined()
  })

  test("a genuine first use may open an empty chat", async () => {
    expect(await resolveStartupSession({ ...input(), remembered: undefined, list: async () => [] })).toBeUndefined()
  })

  test("native Windows path spellings preserve the saved conversation", async () => {
    const saved = { id: "ses_windows", directory: "C:\\Users\\Test\\Project" }
    expect(
      (
        await resolveStartupSession({
          ...input(),
          root: saved.directory,
          directories: ["C:/Users/Test/Project"],
          remembered: saved,
          get: async () => session(saved.id, "C:/Users/Test/Project"),
        })
      )?.id,
    ).toBe("ses_windows")
  })

  test("list responses are confined to the queried workspace and cannot inject another project", async () => {
    expect(
      await resolveStartupSession({
        ...input(),
        remembered: undefined,
        list: async () => [session("ses_unrelated", "/unrelated")],
      }),
    ).toBeUndefined()
  })

  test("restores a valid saved worktree omitted from initial project metadata", async () => {
    expect(
      (
        await resolveStartupSession({
          ...input(),
          directories: ["/project"],
          remembered: { id: "ses_saved", directory: "/worktree" },
          worktrees: async () => ["/worktree"],
          get: async () => session("ses_saved", "/worktree"),
        })
      )?.id,
    ).toBe("ses_saved")
  })

  test("failed authoritative worktree lookup preserves the saved selection instead of falling back", async () => {
    await expect(
      resolveStartupSession({
        ...input(),
        directories: ["/project"],
        remembered: { id: "ses_saved", directory: "/worktree" },
        worktrees: async () => {
          throw new Error("worktree lookup unavailable")
        },
        list: async () => {
          throw new Error("must not fall back")
        },
      }),
    ).rejects.toThrow("worktree lookup unavailable")
  })

  test("a failed restore can retry without clearing the saved selection", async () => {
    let attempts = 0
    const lookup = {
      ...input(),
      get: async () => {
        if (++attempts === 1) throw new Error("temporarily unavailable")
        return session("ses_saved")
      },
    }
    await expect(resolveStartupSession(lookup)).rejects.toThrow("temporarily unavailable")
    expect((await resolveStartupSession(lookup))?.id).toBe(saved.id)
    expect(lookup.remembered).toEqual(saved)
  })

  test("rejects saved session ID or directory mismatches and unrelated workspaces", async () => {
    for (const found of [session("ses_other"), session("ses_saved", "/unrelated")]) {
      expect((await resolveStartupSession({ ...input(), get: async () => found }))?.id).toBe("ses_newer")
    }
    expect(
      (
        await resolveStartupSession({
          ...input(),
          remembered: { ...saved, directory: "/unrelated" },
          get: async () => {
            throw new Error("must not request unrelated project")
          },
        })
      )?.id,
    ).toBe("ses_newer")
  })

  test("temporary lookup or list failures do not become an empty conversation", async () => {
    await expect(
      resolveStartupSession({
        ...input(),
        get: async () => {
          throw new Error("offline")
        },
      }),
    ).rejects.toThrow("offline")
    await expect(
      resolveStartupSession({
        ...input(),
        get: async () => undefined,
        list: async () => {
          throw new Error("unavailable")
        },
      }),
    ).rejects.toThrow("unavailable")
    expect(saved).toEqual({ id: "ses_saved", directory: "/project" })
  })

  test("a delayed response cannot restore over a user's new navigation or a disposed window", async () => {
    let current = true
    expect(
      await resolveStartupSession({
        ...input(),
        current: () => current,
        get: async () => {
          current = false
          return session("ses_saved")
        },
      }),
    ).toBeUndefined()
    expect(
      await resolveStartupSession({
        ...input(),
        current: () => false,
        get: async () => {
          throw new Error("must not load after disposal")
        },
      }),
    ).toBeUndefined()
  })
})

describe("startup attempt authority", () => {
  test("an older delayed attempt cannot replace the result of a newer attempt", async () => {
    const guard = createStartupRestoreGuard()
    const delayed = Promise.withResolvers<Session>()
    const first = guard.begin(() => true)
    const old = resolveStartupSession({
      root: "/project",
      directories: ["/project"],
      remembered: { id: "ses_old", directory: "/project" },
      current: first,
      get: () => delayed.promise,
      list: async () => [],
      worktrees: async () => [],
    })
    const second = guard.begin(() => true)
    const latest = await resolveStartupSession({
      root: "/project",
      directories: ["/project"],
      remembered: { id: "ses_new", directory: "/project" },
      current: second,
      get: async () => session("ses_new"),
      list: async () => [],
      worktrees: async () => [],
    })
    delayed.resolve(session("ses_old"))
    expect(await old).toBeUndefined()
    expect(latest?.id).toBe("ses_new")
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  test("navigation away and back, or disposal, permanently revokes the old attempt", () => {
    const guard = createStartupRestoreGuard()
    const current = guard.begin(() => true)
    guard.cancel()
    expect(current()).toBe(false)
    const next = guard.begin(() => true)
    guard.cancel()
    expect(next()).toBe(false)
  })
})

describe("shipped startup ownership", () => {
  test("root routing cannot bypass persisted layout restoration with a blank-chat redirect", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
    const layout = readFileSync(new URL("./pages/layout.tsx", import.meta.url), "utf8")
    expect(app).toContain('<Route path="/" component={HomeRoute} />')
    expect(app).not.toContain("startupChatPath")
    expect(layout).toContain('platform.platform === "desktop" || !USE_NEW_DESIGN')
    expect(layout).toContain("pageReady() && layoutReady()")
    expect(layout).toContain("server.ready() && globalSync.ready")
    expect(layout).toContain("remembered: store.lastProjectSession[root]")
    expect(layout).toContain("navigate(startupChatPath(root, session), { replace: true })")
    expect(layout).toContain("if (!current()) return")
    expect(layout).toContain("result.response.status === 404")
    expect(layout).toContain("() => [location.pathname, server.key]")
    expect(layout).toContain("() => startupGuard.cancel()")
    expect(layout).toContain("startupGuard.begin(")
    expect(layout).toContain("if (autoselecting.loading) return")
    expect(layout).toContain("await globalSDK.client.worktree.list")
  })
})

describe("desktop startup chat routing", () => {
  test("restores the remembered conversation instead of a blank chat", () => {
    expect(startupChatPath("/project", { id: "ses_saved", directory: "/project" })).toBe(
      "/L3Byb2plY3Q/session/ses_saved",
    )
  })

  test("restores the conversation in its original worktree", () => {
    expect(startupChatPath("/project", { id: "ses_saved", directory: "/worktree" })).toBe(
      "/L3dvcmt0cmVl/session/ses_saved",
    )
  })

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
