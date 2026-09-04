export const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"
export const CODING_MODEL = `bharatcode/${CODING_MODEL_ID}`
export const ACCESS_REQUIRED_MESSAGE =
  "BharatCode App is only available to Pro subscribers. If you're a student, please sign in with your student email id instead or reach out at help@bharatcode.ai to verify your student status. BharatCode Chat is free for all users, visit chat.bharatcode.ai."

export function isAccessRequired(providerID: string, status: number | undefined, errorCode: string | undefined) {
  return providerID === "bharatcode" && status === 402 && errorCode === "subscription_required"
}

export function recoveryMessage() {
  return `BharatCode supports only ${CODING_MODEL}. Retired model IDs are not translated.`
}

export function rejection(modelID: string) {
  if (modelID === CODING_MODEL_ID) return
  return {
    suggestions: [CODING_MODEL_ID],
    reason: recoveryMessage(),
  }
}

export * as BharatCodeModel from "./model"
