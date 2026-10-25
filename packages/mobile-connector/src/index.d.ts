export type MobileDevice = { id: string; name: string; pairedAt: number }
export type MobileClaim = { claimID: string; name: string; confirmation: string; expiresAt: number }
export type MobileState = { enabled: boolean; connecting: boolean; status: "off" | "provisioning" | "connected" | "reconnecting" | "error"; progress?: string; devices: MobileDevice[]; requests: MobileClaim[]; pairing?: string; qrImage?: string; errorKey?: string }
export type MobileAction = { type: 'state' | 'pair' | 'disable' | 'reset' | 'approve' | 'decline' | 'revoke'; id?: string }
export type MobileAccess = { snapshot(): MobileState; action(input: MobileAction): Promise<MobileState>; restore(): Promise<void>; close(): Promise<void> }
export function createMobileAccess(options: { userDataPath: string; getConnection(): { url: string; username?: string | null; password: string } | undefined; onChange?(state: MobileState): void }): Promise<MobileAccess>
