export type ChatImportStatus = { state: "pending" | "complete" | "failed"; imported: number; skipped: number }
let status: ChatImportStatus = { state: "complete", imported: 0, skipped: 0 }
export const getChatImportStatus = () => ({ ...status })
export function setChatImportStatus(value: ChatImportStatus) {
  status = value
}
