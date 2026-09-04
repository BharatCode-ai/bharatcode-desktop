export const ACCESS_REQUIRED_MESSAGE =
  "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."

export const HEAVY_TIER_ACCESS_MESSAGE =
  "Heavy tier models are only available to BharatCode Pro subscribers. Please visit https://bharatcode.ai/subscribe to become a subscriber."

export const MODEL_ACCESS_DENIED_MESSAGE = "This BharatCode model is not available for your account."

export function isAccessRequired(providerID: string, status: number | undefined, errorCode: string | undefined) {
  return providerID === "bharatcode" && status === 402 && errorCode === "subscription_required"
}

export function apiDenialMessage(input: {
  providerID: string
  status: number | undefined
  errorCode: string | undefined
  serverMessage: string | undefined
}) {
  if (isAccessRequired(input.providerID, input.status, input.errorCode)) return ACCESS_REQUIRED_MESSAGE
  if (input.providerID !== "bharatcode" || input.errorCode !== "model_not_in_plan") return
  if (input.status === 403 && input.serverMessage === HEAVY_TIER_ACCESS_MESSAGE) return input.serverMessage
  return MODEL_ACCESS_DENIED_MESSAGE
}

export function recoveryMessage() {
  return "BharatCode coding models are supplied by the authenticated catalog. Retired model IDs are not translated."
}

export * as BharatCodeModel from "./model"
