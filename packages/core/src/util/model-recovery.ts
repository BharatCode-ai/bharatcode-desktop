export const MODEL_SIGN_IN_REQUIRED =
  "Your BharatCode session needs attention. Sign in again, then retry. In the CLI, run 'bharatcode auth login'."
export const MODEL_CATALOG_UNAVAILABLE =
  "BharatCode could not load the model catalog. Retry when the connection is available."
export const MODEL_STORAGE_UNAVAILABLE =
  "BharatCode could not read account storage. Check Account settings, then retry."
export const STUDENT_VERIFICATION_URL = "https://bharatcode.ai/account#student-email-title"
export const MODEL_ACCESS_REQUIRED =
  "Coding access requires BharatCode Lite, Pro or verified student status. Students: verify your college email at https://bharatcode.ai/account#student-email-title, then refresh Account status and retry. Already subscribed? Check that you signed in with the right account."

export function modelRecoveryAction(message: string) {
  if (message === MODEL_ACCESS_REQUIRED) return "verify-student"
  if (message === MODEL_SIGN_IN_REQUIRED) return "sign-in"
  if (message === MODEL_CATALOG_UNAVAILABLE || message === MODEL_STORAGE_UNAVAILABLE) return "retry"
}
