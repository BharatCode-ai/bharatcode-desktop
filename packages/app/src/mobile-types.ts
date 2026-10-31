export type MobileAction = { type: "state" | "pair" | "disable" | "reset" | "approve" | "decline" | "revoke"; id?: string }
export type MobileState = {
  enabled: boolean
  status: "off" | "provisioning" | "connected" | "reconnecting" | "error"
  progress?: string
  connecting: boolean
  devices: { id: string; name: string; pairedAt: number }[]
  requests: { claimID: string; name: string; confirmation: string; expiresAt: number }[]
  pairing?: string
  qrImage?: string
  errorKey?: string
}
