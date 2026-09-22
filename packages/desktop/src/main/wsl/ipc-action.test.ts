import { expect, test } from "bun:test"
import { wslIpcAction } from "./ipc-action"

test("WSL actions require an owned main frame before doing any work", async () => {
  const frame = {}
  const event = { sender: { id: 7, mainFrame: frame, isDestroyed: () => false }, senderFrame: frame }
  let calls = 0
  const action = wslIpcAction(
    async () => ++calls,
    (id) => id === 7,
  )
  await expect(action({ ...event, senderFrame: {} })).rejects.toThrow("This window cannot manage")
  await expect(action({ ...event, sender: { ...event.sender, id: 8 } })).rejects.toThrow("This window cannot manage")
  await expect(action({ ...event, sender: { ...event.sender, isDestroyed: () => true } })).rejects.toThrow(
    "This window cannot manage",
  )
  expect(calls).toBe(0)
  expect(await action(event)).toBe(1)
})

test("WSL action errors never forward child output or secret-bearing errors", async () => {
  const frame = {}
  const event = { sender: { id: 7, mainFrame: frame, isDestroyed: () => false }, senderFrame: frame }
  const action = wslIpcAction(
    async () => {
      throw new Error("secret-token command-line private-path")
    },
    () => true,
  )
  await expect(action(event)).rejects.toThrow("The WSL action could not be completed. Check WSL status and try again.")
})
