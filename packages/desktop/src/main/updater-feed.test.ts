import { expect, test } from "bun:test"
import { GenericProvider } from "electron-updater/out/providers/GenericProvider"
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider"
import { checkDesktopStableUpdate } from "./updater-feed"

const release = (tag_name: string, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra })
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
  ["win32", "latest.yml"],
  ["darwin", "latest-mac.yml"],
  ["linux", "latest-linux.yml"],
]) {
  test(`Desktop stable uses installed generic provider with exact ${platform} metadata and artifact URLs`, async () => {
    const paths: string[] = []
    let provider: InstanceType<typeof GenericProvider>
    const result = await checkDesktopStableUpdate(
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
            "https://github.com/BharatCode-ai/bharatcode-desktop/releases/download/desktop-1.15.36/bharatcode-desktop-fixture.zip",
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
          release("desktop-1.15.9"),
          release("desktop-1.15.36"),
          release("desktop-9.0.0", { draft: true }),
          release("desktop-8.0.0", { prerelease: true }),
          release("desktop-beta-99.0.0", { prerelease: true }),
          release("desktop-beta-99.0.0"),
          release("desktop-09.0.0"),
          release("desktop-99999999999999999.0.0"),
          release("desktop-8.0.0-rc.1"),
          release("desktop-2026-09-24-diagnostic"),
        ])
      },
    )
    expect(result.isUpdateAvailable).toBe(true)
    expect(paths).toEqual([`/BharatCode-ai/bharatcode-desktop/releases/download/desktop-1.15.36/${filename}`])
  })
}

test("failed discovery never invokes the updater or falls back to CLI", async () => {
  for (const response of [
    Response.json([], { status: 200 }),
    Response.json([release("v1.15.36"), release("desktop-beta-1.15.48", { prerelease: true })]),
    Response.json({}),
    new Response("rate limited", { status: 403 }),
    new Response("not JSON"),
  ]) {
    let calls = 0
    await expect(
      checkDesktopStableUpdate(
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

test("stable discovery follows release pages on the known endpoint, never a supplied host", async () => {
  const requests: string[] = []
  const endpoint = "https://api.github.com/repos/BharatCode-ai/bharatcode-desktop/releases?per_page=100"
  await checkDesktopStableUpdate(
    {
      setFeedURL(options) {
        expect(options.url).toEndWith("/desktop-1.16.0/")
        expect(options.channel).toBe("latest")
      },
      async checkForUpdates() {
        return { updateInfo: { version: "1.16.0", files: [{ url: "bharatcode-desktop-win-x64.exe" }] } }
      },
    },
    async (url) => {
      requests.push(String(url))
      return requests.length === 1
        ? Response.json([release("v99.0.0"), release("desktop-1.15.48")], {
            headers: { link: '<https://example.invalid>; rel="next"' },
          })
        : Response.json([release("desktop-1.16.0")])
    },
  )
  expect(requests).toEqual([endpoint, endpoint + "&page=2"])
})

test("metadata failure or a version different from the selected tag fails rather than falling back", async () => {
  for (const version of [undefined, "1.15.35", "99.0.0"]) {
    await expect(
      checkDesktopStableUpdate(
        {
          setFeedURL() {},
          async checkForUpdates() {
            return { updateInfo: { version } }
          },
        },
        async () => Response.json([release("desktop-1.15.36")]),
      ),
    ).rejects.toThrow("Desktop update feed unavailable")
  }
  await expect(
    checkDesktopStableUpdate(
      {
        setFeedURL() {},
        async checkForUpdates() {
          throw new Error("missing metadata")
        },
      },
      async () => Response.json([release("desktop-1.15.36")]),
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
      return {
        isUpdateAvailable: false,
        updateInfo: { version: "1.15.36", files: [{ url: "bharatcode-desktop-win-x64.exe" }] },
      }
    },
  }
  await expect(
    checkDesktopStableUpdate(backend, async () => {
      throw new DOMException("Timed out", "TimeoutError")
    }),
  ).rejects.toThrow("Timed out")
  expect(configured).toBe(0)
  expect(await checkDesktopStableUpdate(backend, async () => Response.json([release("desktop-1.15.36")]))).toEqual({
    isUpdateAvailable: false,
    updateInfo: { version: "1.15.36", files: [{ url: "bharatcode-desktop-win-x64.exe" }] },
  })
  expect(configured).toBe(1)
})

test("even matching-version metadata cannot point the stable updater to a CLI or another release", async () => {
  for (const metadata of [
    { files: [{ url: "bharatcode-cli.exe" }] },
    { files: [{ url: "https://example.invalid/bharatcode-desktop-win-x64.exe" }] },
    { files: [{ url: "../desktop-beta-1.15.48/bharatcode-desktop-win-x64.exe" }] },
    { files: [{ url: "bharatcode-desktop-win-x64.exe" }], path: "other.exe" },
    { files: [{ url: "bharatcode-desktop-win-x64.exe" }], packages: { x64: { path: "cli.exe" } } },
  ]) {
    await expect(
      checkDesktopStableUpdate(
        {
          setFeedURL() {},
          async checkForUpdates() {
            return { updateInfo: { version: "1.15.48", ...metadata } }
          },
        },
        async () => Response.json([release("desktop-1.15.48")]),
      ),
    ).rejects.toThrow("Desktop update feed unavailable")
  }
})
