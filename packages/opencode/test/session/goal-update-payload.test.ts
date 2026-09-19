import { expect, test } from "bun:test"
import { Schema } from "effect"
import { UpdatePayload } from "@/server/routes/instance/httpapi/groups/session"

test("session update payload accepts goal command intents", () => {
  expect(Schema.decodeUnknownSync(UpdatePayload)({ goal: { action: "set", text: "Ship Goal Mode" } }).goal).toEqual({
    action: "set",
    text: "Ship Goal Mode",
  })
  expect(Schema.decodeUnknownSync(UpdatePayload)({ goal: { action: "pause" } }).goal).toEqual({ action: "pause" })
  expect(Schema.decodeUnknownSync(UpdatePayload)({ goal: { action: "resume" } }).goal).toEqual({ action: "resume" })
  expect(Schema.decodeUnknownSync(UpdatePayload)({ goal: { action: "clear" } }).goal).toEqual({ action: "clear" })
})

test("session update payload rejects raw persisted goal objects", () => {
  expect(() =>
    Schema.decodeUnknownSync(UpdatePayload)({
      goal: {
        text: "Raw stored state",
        status: "active",
        created: 1,
        updated: 1,
        accumulated: 0,
        activeSince: 1,
      },
    }),
  ).toThrow()
})
