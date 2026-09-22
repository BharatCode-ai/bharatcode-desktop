import { expect, test } from "bun:test"
import { runtimeAccountApi } from "./runtime-account"
import type { ElectronAPI } from "../preload/types"

test("each account surface captures its runtime, including cancel and events", async () => {
  const calls: unknown[] = []
  const api = {
    getAccountStatus: async (id: string) => {
      calls.push(["get", id])
    },
    refreshAccountStatus: async (id: string) => {
      calls.push(["refresh", id])
    },
    beginSignIn: async (input: unknown) => {
      calls.push(["sign-in", input])
    },
    cancelSignIn: async (id: string) => {
      calls.push(["cancel", id])
    },
    logout: async (id: string) => {
      calls.push(["logout", id])
    },
    onAccountStatusChanged: (_: unknown, id: string) => {
      calls.push(["listen", id])
      return () => {
        calls.push(["dispose", id])
      }
    },
  } as unknown as ElectronAPI
  const native = runtimeAccountApi(api, "sidecar")
  const wsl = runtimeAccountApi(api, "wsl:Ubuntu")
  await wsl.getAccountStatus()
  await native.getAccountStatus()
  await wsl.refreshAccountStatus()
  await wsl.beginSignIn({ selectAccount: true })
  await wsl.cancelSignIn()
  await wsl.logout()
  const unsubscribe = wsl.onAccountStatusChanged(() => {})
  unsubscribe()
  expect(calls).toEqual([
    ["get", "wsl:Ubuntu"],
    ["get", "sidecar"],
    ["refresh", "wsl:Ubuntu"],
    ["sign-in", { selectAccount: true, runtimeId: "wsl:Ubuntu" }],
    ["cancel", "wsl:Ubuntu"],
    ["logout", "wsl:Ubuntu"],
    ["listen", "wsl:Ubuntu"],
    ["dispose", "wsl:Ubuntu"],
  ])
})
