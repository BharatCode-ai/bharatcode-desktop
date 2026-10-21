import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSupportExportController } from "./settings-support"

test("support export coalesces clicks, reports saved state without path, and permits another export", async () => {
  const pending = Promise.withResolvers<string>()
  let calls = 0
  const root = createRoot((dispose) => ({
    controller: createSupportExportController(() => {
      calls++
      return pending.promise
    }),
    dispose,
  }))
  expect(root.controller.state.status).toBe("idle")
  const run = root.controller.run()
  void root.controller.run()
  expect(root.controller.state.status).toBe("saving")
  await Promise.resolve()
  expect(calls).toBe(1)
  pending.resolve("/home/private/support.zip")
  await run
  expect(root.controller.state.status).toBe("saved")
  expect(JSON.stringify(root.controller.state)).not.toContain("private")
  await root.controller.run()
  expect(calls).toBe(2)
  root.dispose()
})

test("support export hides paths/errors and recovers for retry", async () => {
  let calls = 0
  const controller = createSupportExportController(async () => {
    if (++calls === 1) throw new Error("sk-private /home/private owner@private.test")
    return "/home/private/support.zip"
  })
  await controller.run()
  expect(controller.state.status).toBe("failed")
  expect(JSON.stringify(controller.state)).not.toContain("private")
  await controller.run()
  expect(controller.state.status).toBe("saved")
  expect(JSON.stringify(controller.state)).toBe('{"status":"saved"}')
})
