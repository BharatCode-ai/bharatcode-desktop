import type { ElectronAPI } from "../preload/types"

// Capture the identity, not a mutable selected-server accessor. An in-flight
// sign-in/cancel must continue addressing the runtime that owns that operation.
export function runtimeAccountApi(api: ElectronAPI, runtimeId: string) {
  return {
    getAccountStatus: () => api.getAccountStatus(runtimeId),
    refreshAccountStatus: () => api.refreshAccountStatus(runtimeId),
    beginSignIn: (input?: { selectAccount?: boolean }) => api.beginSignIn({ ...input, runtimeId }),
    cancelSignIn: () => api.cancelSignIn(runtimeId),
    logout: () => api.logout(runtimeId),
    onAccountStatusChanged: (callback: Parameters<ElectronAPI["onAccountStatusChanged"]>[0]) =>
      api.onAccountStatusChanged(callback, runtimeId),
  }
}
