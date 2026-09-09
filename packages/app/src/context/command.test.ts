import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isEditableKeybindAllowed, productCommandOptions, upsertCommandRegistration } from "./command"

describe("upsertCommandRegistration", () => {
  test("replaces keyed registrations", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = upsertCommandRegistration([{ key: "layout", options: one }], { key: "layout", options: two })

    expect(next).toHaveLength(1)
    expect(next[0]?.options).toBe(two)
  })

  test("keeps unkeyed registrations additive", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = upsertCommandRegistration([{ options: one }], { options: two })

    expect(next).toHaveLength(2)
    expect(next[0]?.options).toBe(two)
    expect(next[1]?.options).toBe(one)
  })
})

describe("editable keybind allowlist", () => {
  test("allows prompt dictation while typing in the composer", () => {
    expect(isEditableKeybindAllowed("prompt.dictate")).toBe(true)
  })
})

describe("Product Core command boundary", () => {
  test("removes generic provider and ShareNext actions from shipped command composition", () => {
    const command = (id: string) => ({ id, title: id })
    expect(
      productCommandOptions([
        command("provider.connect"),
        command("session.share"),
        command("session.unshare"),
        command("session.new"),
      ]).map((item) => item.id),
    ).toEqual(["session.new"])
  })

  test("has no shipped provider-connect surface or import edge", async () => {
    const files = [
      "../pages/layout.tsx",
      "../components/dialog-settings.tsx",
      "../components/dialog-select-model.tsx",
      "../components/dialog-manage-models.tsx",
      "../components/dialog-select-model-unpaid.tsx",
    ]
    const shipped = (await Promise.all(files.map((file) => readFile(join(import.meta.dir, file), "utf8")))).join("\n")
    expect(shipped).not.toMatch(
      /provider\.connect|DialogSelectProvider|DialogConnectProvider|dialog-select-provider|dialog-connect-provider/,
    )
  })
})
