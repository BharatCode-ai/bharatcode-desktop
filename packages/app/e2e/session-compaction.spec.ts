import { test, expect } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "./utils/mock-server"
import { fixture } from "./performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./performance/timeline/timeline-test-helpers"

for (const newLayoutDesigns of [false, true]) {
  test(`compaction summary stays internal in ${newLayoutDesigns ? "new" : "legacy"} layout`, async ({ page }) => {
    if (!newLayoutDesigns) await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"))
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const user = structuredClone(fixture.messages[fixture.sourceID].find((message) => message.info.role === "user")!)
    const assistant = structuredClone(
      fixture.messages[fixture.sourceID].find((message) => message.info.role === "assistant")!,
    )
    const messages = [
      {
        info: { ...user.info, id: "msg_compact", time: { created: 1700000000000 } },
        parts: [
          { id: "prt_compact", type: "compaction", messageID: "msg_compact", sessionID: fixture.sourceID, auto: true },
        ],
      },
      {
        info: {
          ...assistant.info,
          id: "msg_summary",
          parentID: "msg_compact",
          summary: true,
          time: { created: 1700000000001, completed: 1700000000002 },
        },
        parts: [
          {
            id: "prt_summary",
            type: "text",
            messageID: "msg_summary",
            sessionID: fixture.sourceID,
            text: "INTERNAL_COMPACTION_HANDOFF_ONLY",
          },
        ],
      },
      {
        info: {
          ...assistant.info,
          id: "msg_continuation",
          parentID: "msg_compact",
          summary: false,
          time: { created: 1700000000003, completed: 1700000000004 },
        },
        parts: [
          {
            id: "prt_continuation",
            type: "text",
            messageID: "msg_continuation",
            sessionID: fixture.sourceID,
            text: "Visible continuation after compaction.",
          },
        ],
      },
    ]
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort(),
    )
    await mockOpenCodeServer(page, {
      protocol: "v1",
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: (id) => ({ items: id === fixture.sourceID ? messages : [] }),
    })
    await installStressSessionTabs(page)
    await page.addInitScript((enabled) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.31" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: enabled } }))
    }, newLayoutDesigns)
    await page.goto(
      newLayoutDesigns
        ? stressSessionHref(fixture.sourceID)
        : `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`,
    )
    await expect(page.getByText("Visible continuation after compaction.", { exact: true })).toBeVisible()
    await expect(page.getByText("INTERNAL_COMPACTION_HANDOFF_ONLY", { exact: true })).toHaveCount(0)
    await expect(page.getByText("Session compacted", { exact: true })).toBeVisible()
    await page.screenshot({ path: `/tmp/bc-compaction-${newLayoutDesigns ? "new" : "legacy"}.png` })
    expect(errors).toEqual([])
  })
}
