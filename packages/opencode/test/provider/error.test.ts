import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "@/provider/error"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { BharatCodeModel } from "@/bharatcode/model"

const STUDENT_REFUSAL =
  "DeepSeek is included with BharatCode Pro. Students get a special discount on Pro: message us on WhatsApp at +91 94083 20098 or email contact@bharatcode.ai. Meanwhile, Qwen 3.8 27B (qwen-3.8-27b) is free for students. Select it in your model picker."

function bharatcodeError(statusCode: number, error: Record<string, unknown>) {
  return ProviderError.parseAPICallError({
    providerID: ProviderV2.ID.make("bharatcode"),
    error: new APICallError({
      message: typeof error.message === "string" ? error.message : "Forbidden",
      url: "https://bharatcode.ai/api/model/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify({ error }),
    }),
  })
}

describe("BharatCode API refusals", () => {
  test("shows the server's plan refusal instead of the generic text", () => {
    const parsed = bharatcodeError(403, {
      message: STUDENT_REFUSAL,
      type: "model_not_in_plan",
      code: "model_not_in_plan",
      action_url: "https://bharatcode.ai/subscribe",
    })
    expect(parsed).toMatchObject({ type: "api_error", message: STUDENT_REFUSAL, isRetryable: false, statusCode: 403 })
    if (parsed.type === "api_error") expect(parsed.responseBody).toBeUndefined()
  })

  test("sanitizes the server text and falls back to the generic text when it is empty", () => {
    expect(bharatcodeError(403, { message: "Needs\u0000 Pro.\n\n Upgrade.", code: "model_not_in_plan" }).message).toBe(
      "Needs Pro. Upgrade.",
    )
    expect(bharatcodeError(403, { message: "x".repeat(2000), code: "model_not_in_plan" }).message.length).toBe(600)
    for (const message of ["", "  \u0007 ", 42])
      expect(bharatcodeError(403, { message, code: "model_not_in_plan" }).message).toBe(
        BharatCodeModel.MODEL_ACCESS_DENIED_MESSAGE,
      )
  })

  test("shows an invalid-request rejection as-is and does not retry it", () => {
    const message = "The model rejected this request: max_tokens must be at most 5000"
    expect(bharatcodeError(400, { message, type: "invalid_request_error", code: "invalid_request" })).toMatchObject({
      type: "api_error",
      message,
      isRetryable: false,
      statusCode: 400,
    })
  })
})

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})
