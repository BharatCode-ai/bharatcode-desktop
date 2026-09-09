import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { ACCESS_DENIAL_MESSAGE } from "@opencode-ai/core/util/access-denial"
import { formatAccessDenial } from "../../src/cli/access-denial"

test("plain and redirected denial errors preserve explicit URLs and two paragraphs", () => {
  expect(formatAccessDenial(ACCESS_DENIAL_MESSAGE, false)).toBe(ACCESS_DENIAL_MESSAGE)
})

test("terminal links bind only three fixed destinations and keep readable URL fallback", () => {
  const value = formatAccessDenial(ACCESS_DENIAL_MESSAGE, true)
  expect(value.match(/\u001b\]8;;[^\u001b]+\u001b\\/g)).toHaveLength(3)
  for (const href of ["https://bharatcode.ai/subscribe", "mailto:help@bharatcode.ai", "https://chat.bharatcode.ai"]) {
    expect(value).toContain(`\u001b]8;;${href}\u001b\\`)
  }
  expect(value.replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "")).toBe(ACCESS_DENIAL_MESSAGE)
})

test("unrelated heavy-tier and hostile errors remain unchanged", () => {
  for (const value of ["Heavy tier requires Pro", "<a href='javascript:alert(1)'>x</a>", ACCESS_DENIAL_MESSAGE + " "]) {
    expect(formatAccessDenial(value, true)).toBe(value)
  }
})

test("actual CLI error writer links only terminal output and keeps redirected output plain", async () => {
  for (const [tty, term, linked] of [
    [true, "xterm-256color", true],
    [false, "xterm-256color", false],
    [true, "dumb", false],
  ] as const) {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { error } from "./src/cli/ui.ts";
      Object.defineProperty(process.stderr, "isTTY", { value: ${tty} });
      error(${JSON.stringify(ACCESS_DENIAL_MESSAGE)});
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, TERM: term },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited).toBe(0)
    expect(stderr.includes("\u001b]8;;")).toBe(linked)
    expect(stderr.replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "")).toContain(ACCESS_DENIAL_MESSAGE)
    expect(await new Response(child.stdout).text()).toBe("")
  }
})
