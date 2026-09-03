export const CODING_MODEL_ID = "bharatcode:qwen36-35b-awq-200k"
export const CODING_MODEL = `bharatcode/${CODING_MODEL_ID}`

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
