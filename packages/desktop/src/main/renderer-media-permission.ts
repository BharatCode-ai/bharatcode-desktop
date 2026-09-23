export function allowMicrophonePermission(input: {
  ownerID: number
  senderID?: number
  trusted: boolean
  isMainFrame: boolean
  mediaType?: string
  mediaTypes?: string[]
}) {
  if (!input.trusted || !input.isMainFrame || input.senderID !== input.ownerID) return false
  if (input.mediaTypes) return input.mediaTypes.length > 0 && input.mediaTypes.every((type) => type === "audio")
  return input.mediaType === "audio"
}
