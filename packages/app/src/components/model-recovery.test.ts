import { expect, test } from "bun:test"
import { checkModelConnection } from "./model-recovery-check"
import {
  MODEL_SIGN_IN_REQUIRED,
  MODEL_CATALOG_UNAVAILABLE,
  modelRecoveryAction,
} from "@opencode-ai/core/util/model-recovery"

test("only known account/catalog errors offer recovery", () => {
  expect(modelRecoveryAction(MODEL_SIGN_IN_REQUIRED)).toBe("sign-in")
  expect(modelRecoveryAction(MODEL_CATALOG_UNAVAILABLE)).toBe("retry")
  expect(modelRecoveryAction("Model unavailable.")).toBeUndefined()
  expect(modelRecoveryAction("Subscription required")).toBeUndefined()
})

test("recovery verifies the selected model rather than a successful HTTP response", async () => {
  const check = (models: string[]) =>
    checkModelConnection({ loadModels: async () => models, modelID: "wanted", current: () => true })
  expect(await check([])).toBe("unavailable")
  expect(await check(["other"])).toBe("unavailable")
  expect(await check(["wanted"])).toBe("restored")
})

test("incomplete sign-in stops before catalog access", async () => {
  let calls = 0
  expect(
    await checkModelConnection({
      signIn: async () => ({ authenticated: false, state: "authorizing" }),
      loadModels: async () => {
        calls++
        return ["wanted"]
      },
      current: () => true,
    }),
  ).toBe("signInIncomplete")
  expect(calls).toBe(0)
})

test("sign-in then catalog check never forwards diagnostic payloads", async () => {
  const order: string[] = []
  expect(
    await checkModelConnection({
      signIn: async () => {
        order.push("sign-in")
        return { authenticated: true, state: "signed_in" }
      },
      loadModels: async () => {
        order.push("catalog")
        throw new Error("secret-token")
      },
      current: () => true,
    }),
  ).toBe("failed")
  expect(order).toEqual(["sign-in", "catalog"])
})

test("obsolete recovery does not load models or publish results", async () => {
  let current = true
  let calls = 0
  expect(
    await checkModelConnection({
      signIn: async () => {
        current = false
        return { authenticated: true, state: "signed_in" }
      },
      loadModels: async () => {
        calls++
        return ["wanted"]
      },
      current: () => current,
    }),
  ).toBeUndefined()
  expect(calls).toBe(0)
  current = true
  expect(
    await checkModelConnection({
      loadModels: async () => {
        current = false
        return ["wanted"]
      },
      current: () => current,
    }),
  ).toBeUndefined()
})
