import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

import { Auth } from "@/auth"
import { BharatCodeAccount } from "@/bharatcode/account"
import { BharatCodeCatalog } from "@/bharatcode/catalog"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ProductPolicy } from "@/product/policy"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { testEffect } from "../lib/effect"

const MESSAGE =
  "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."

const providerLayer = Provider.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AppFileSystem.defaultLayer,
      Env.defaultLayer,
      Config.defaultLayer,
      Auth.defaultLayer,
      Plugin.defaultLayer,
      RuntimeFlags.defaultLayer,
      ProductPolicy.shippedLayer,
      BharatCodeAccount.defaultLayer,
      Layer.mock(BharatCodeCatalog.Service, {
        list: () =>
          Effect.fail(
            new BharatCodeAccount.ServiceError({
              operation: "model catalog",
              status: 402,
              errorCode: "subscription_required",
              retriable: false,
              message: "BharatCode model catalog is currently unavailable.",
            }),
          ),
      }),
    ),
  ),
)

const it = testEffect(providerLayer)

it.instance("carries a protected-catalog subscription denial through model lookup", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const failure = yield* provider
      .getModel(ProviderID.make("bharatcode"), ModelID.make("bharatcode:qwen36-35b-awq-200k"))
      .pipe(Effect.flip)

    expect(failure).toBeInstanceOf(Provider.ModelNotFoundError)
    expect(failure.reason).toBe(MESSAGE)
    expect(Provider.modelNotFoundMessage(failure)).toBe(MESSAGE)
    expect(Provider.modelNotFoundMessage(failure)).not.toContain("Model not found")
  }),
)
