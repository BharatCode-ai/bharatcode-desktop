import { afterAll, expect, test } from "bun:test"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { ACCESS_DENIAL_MESSAGE } from "@opencode-ai/core/util/access-denial"

// Render the actual Solid component; do not load the UI dev config or its network plugins.
const server = await createServer({
  configFile: false,
  plugins: [solid({ ssr: true })],
  server: { middlewareMode: true },
})
afterAll(() => server.close())
const { AccessDenial } = await server.ssrLoadModule("/src/components/access-denial.tsx")
const { renderToString } = await import("solid-js/web")

test("renders two paragraphs with only the three intended clickable links", () => {
  const html = renderToString(() => AccessDenial({ message: ACCESS_DENIAL_MESSAGE }))
  expect(html.match(/<p(?:\s[^>]*)?>/g)).toHaveLength(2)
  expect(html.match(/<a /g)).toHaveLength(3)
  for (const href of ["https://bharatcode.ai/subscribe", "mailto:help@bharatcode.ai", "https://chat.bharatcode.ai"]) {
    expect(html).toContain(`href="${href}"`)
  }
  expect(html).toContain("Subscribe to Pro</a>")
  expect(html).toContain("BharatCode Chat</a>")
  expect(html).toContain("external-link")
  expect(html).toContain('rel="noopener noreferrer"')
})

test("untrusted and other errors stay escaped plain text", () => {
  const html = renderToString(() => AccessDenial({ message: '<a href="javascript:alert(1)">bad</a>' }))
  expect(html).not.toContain("<a ")
  expect(html).toContain("&lt;a")
  expect(renderToString(() => AccessDenial({ message: "Heavy-tier Pro required" }))).toContain(
    "Heavy-tier Pro required",
  )
})
