import { expect, test } from "bun:test"
import { GenericProvider } from "electron-updater/out/providers/GenericProvider"
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider"
import { checkDesktopBetaUpdate } from "./updater-feed"

const release = (tag_name: string, extra = {}) => ({ tag_name, draft: false, prerelease: true, ...extra })
const feed = (tags: string[]) =>
  `<feed>${tags.map((tag) => `<entry><title>Fixture</title><link href="https://github.com/BharatCode-ai/bharatcode-desktop/releases/tag/${tag}"/><content>Fixture</content></entry>`).join("")}</feed>`

test("installed GitHub provider reproduces the Desktop tag / CLI release mismatch", async () => {
  const paths: string[] = []
  const provider = new GitHubProvider(
    { owner: "BharatCode-ai", repo: "bharatcode-desktop" },
    { channel: "beta", allowPrerelease: true, currentVersion: "1.15.35" },
    {
      platform: "win32",
      executor: {
        async request(options: { path: string }) {
          paths.push(options.path)
          if (options.path.endsWith(".atom")) return feed(["desktop-beta-1.15.36", "v1.15.36"])
          throw new Error("CLI release has no Desktop metadata")
        },
      },
    },
  )
  await expect(provider.getLatestVersion()).rejects.toThrow("CLI release has no Desktop metadata")
  expect(paths.slice(1)).toEqual([
    "/BharatCode-ai/bharatcode-desktop/releases/download/v1.15.36/beta.yml",
    "/BharatCode-ai/bharatcode-desktop/releases/download/v1.15.36/latest.yml",
  ])
})

for (const [platform, filename] of [
  ["win32", "beta.yml"],
  ["darwin", "beta-mac.yml"],
  ["linux", "beta-linux.yml"],
]) {
  test(`Desktop beta uses installed generic provider with exact ${platform} metadata and artifact URLs`, async () => {
    const paths: string[] = []
    let provider: InstanceType<typeof GenericProvider>
    const result = await checkDesktopBetaUpdate(
      {
        setFeedURL(options) {
          expect(options.useMultipleRangeRequests).toBe(false)
          provider = new GenericProvider(
            options,
            { isAddNoCacheQuery: false },
            {
              platform,
              executor: {
                async request(options: { path: string }) {
                  paths.push(options.path)
                  return "version: 1.15.36\nfiles:\n  - url: bharatcode-desktop-fixture.zip\n    sha512: Zml4dHVyZQ==\n    size: 7\n"
                },
              },
            },
          )
        },
        async checkForUpdates() {
          const updateInfo = await provider.getLatestVersion()
          expect(provider.resolveFiles(updateInfo)[0].url.href).toBe(
            "https://github.com/BharatCode-ai/bharatcode-desktop/releases/download/desktop-beta-1.15.36/bharatcode-desktop-fixture.zip",
          )
          return { isUpdateAvailable: true, updateInfo }
        },
      },
      async (url, options) => {
        expect(String(url)).toBe("https://api.github.com/repos/BharatCode-ai/bharatcode-desktop/releases?per_page=100")
        expect(options?.signal).toBeInstanceOf(AbortSignal)
        expect(options?.redirect).toBe("error")
        return Response.json([
          release("v99.0.0"),
          release("desktop-beta-1.15.9"),
          release("desktop-beta-1.15.36"),
          release("desktop-beta-9.0.0", { draft: true }),
          release("desktop-beta-8.0.0", { prerelease: false }),
          release("desktop-beta-2026-09-24-diagnostic"),
        ])
      },
    )
    expect(result.isUpdateAvailable).toBe(true)
    expect(paths).toEqual([`/BharatCode-ai/bharatcode-desktop/releases/download/desktop-beta-1.15.36/${filename}`])
  })
}

test("failed discovery never invokes the updater or falls back to CLI", async () => {
  for (const response of [
    Response.json([], { status: 200 }),
    Response.json([release("v1.15.36")]),
    Response.json({}),
    new Response("rate limited", { status: 403 }),
    new Response("not JSON"),
  ]) {
    let calls = 0
    await expect(
      checkDesktopBetaUpdate(
        {
          setFeedURL() {
            calls++
          },
          async checkForUpdates() {
            calls++
            return null
          },
        },
        async () => response,
      ),
    ).rejects.toThrow()
    expect(calls).toBe(0)
  }
})

test("metadata failure or a version different from the selected tag fails rather than falling back", async () => {
  for (const version of [undefined, "1.15.35", "99.0.0"]) {
    await expect(
      checkDesktopBetaUpdate(
        {
          setFeedURL() {},
          async checkForUpdates() {
            return { updateInfo: { version } }
          },
        },
        async () => Response.json([release("desktop-beta-1.15.36")]),
      ),
    ).rejects.toThrow("Desktop update feed unavailable")
  }
  await expect(
    checkDesktopBetaUpdate(
      {
        setFeedURL() {},
        async checkForUpdates() {
          throw new Error("missing metadata")
        },
      },
      async () => Response.json([release("desktop-beta-1.15.36")]),
    ),
  ).rejects.toThrow("missing metadata")
})

test("discovery network failure does not reuse an old feed; same-version results remain up-to-date", async () => {
  let configured = 0
  const backend = {
    setFeedURL() {
      configured++
    },
    async checkForUpdates() {
      return { isUpdateAvailable: false, updateInfo: { version: "1.15.36" } }
    },
  }
  await expect(
    checkDesktopBetaUpdate(backend, async () => {
      throw new DOMException("Timed out", "TimeoutError")
    }),
  ).rejects.toThrow("Timed out")
  expect(configured).toBe(0)
  expect(await checkDesktopBetaUpdate(backend, async () => Response.json([release("desktop-beta-1.15.36")]))).toEqual({
    isUpdateAvailable: false,
    updateInfo: { version: "1.15.36" },
  })
  expect(configured).toBe(1)
})
