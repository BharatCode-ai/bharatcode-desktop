export const ACCESS_REQUIRED_MESSAGE =
  "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."

export function isAccessRequired(providerID: string, status: number | undefined, errorCode: string | undefined) {
  return providerID === "bharatcode" && status === 402 && errorCode === "subscription_required"
}

export function recoveryMessage() {
  return "BharatCode coding models are supplied by the authenticated catalog. Retired model IDs are not translated."
}

export * as BharatCodeModel from "./model"
