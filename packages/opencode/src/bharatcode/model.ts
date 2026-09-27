export const ACCESS_REQUIRED_MESSAGE =
  "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."

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
  // The refusal comes from our own API and carries the plan-specific next step
  // (e.g. the student Pro offer), so show it. The generic text is only a fallback.
  if (input.status === 403) return serverText(input.serverMessage) ?? MODEL_ACCESS_DENIED_MESSAGE
  return MODEL_ACCESS_DENIED_MESSAGE
}

const SERVER_MESSAGE_MAX_LENGTH = 600

// Displayable form of a server-supplied message: control characters removed,
// whitespace collapsed, length capped.
export function serverText(value: string | undefined) {
  if (typeof value !== "string") return
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return
  return text.length > SERVER_MESSAGE_MAX_LENGTH ? `${text.slice(0, SERVER_MESSAGE_MAX_LENGTH - 1).trimEnd()}…` : text
}

export function recoveryMessage() {
  return "BharatCode coding models are supplied by the authenticated catalog. Retired model IDs are not translated."
}

export * as BharatCodeModel from "./model"
