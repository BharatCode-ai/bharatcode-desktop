// Product-specific copy uses English fallback until translations are reviewed.
// Kept separate from upstream's positional native-menu translation arrays.
export const BHARATCODE_NATIVE_ENGLISH = {
  "desktop.account.error.sender": "This window cannot access the BharatCode account.",
  "desktop.account.error.request": "The BharatCode account request could not be completed. Try again.",
  "desktop.error.initialization": "BharatCode could not start its local server. Restart the app to try again.",
  "desktop.account.error.cancelled": "BharatCode sign-in was cancelled. Try again.",
  "desktop.account.error.status": "Could not check the BharatCode account. Try again.",
  "desktop.account.error.unavailable": "The BharatCode account runtime is unavailable.",
  "desktop.account.error.timeout": "Timed out waiting for BharatCode sign-in. Try again.",
  "desktop.account.error.start": "Could not start BharatCode sign-in. Try again.",
  "desktop.account.error.complete": "BharatCode sign-in could not be completed. Try again.",
  "desktop.account.error.logout": "Could not sign out of BharatCode. Try again.",
  "desktop.account.error.storage":
    "BharatCode account storage is unavailable. Check local credential-store access, then retry.",
  "desktop.account.error.connection": "Could not connect to BharatCode. Your saved sign-in has been kept. Try again.",
  "desktop.account.error.signInRequired": "Sign in to BharatCode again to continue.",
} as const

export const BHARATCODE_ENGLISH = {
  ...BHARATCODE_NATIVE_ENGLISH,
  "settings.account.title": "Account",
  "settings.account.state.checking.title": "Checking account",
  "settings.account.state.checking.description": "Desktop is checking your BharatCode sign-in on this device.",
  "settings.account.state.signedOut.title": "Sign in to BharatCode",
  "settings.account.state.signedOut.description": "Sign in once to use BharatCode models from Desktop.",
  "settings.account.state.signedIn.title": "Signed in",
  "settings.account.state.signedIn.description": "Desktop is connected to BharatCode.",
  "settings.account.state.needsSignIn.title": "Sign in again",
  "settings.account.state.needsSignIn.description":
    "Your BharatCode sign-in needs to be refreshed before model requests can run.",
  "settings.account.state.connectionIssue.title": "Connection issue",
  "settings.account.state.connectionIssue.description":
    "You are signed in, but Desktop could not reach BharatCode for the last connection check.",
  "settings.account.action.signIn": "Sign in",
  "settings.account.action.reconnect": "Reconnect BharatCode",
  "settings.account.action.useAnother": "Use another account",
  "settings.account.action.signingIn": "Waiting for browser sign-in...",
  "settings.account.action.refresh": "Refresh status",
  "settings.account.action.refreshing": "Checking...",
  "settings.account.action.exportLogs": "Export logs",
  "settings.account.action.exporting": "Exporting...",
  "settings.account.section.details": "Status",
  "settings.account.section.support": "Support",
  "settings.account.row.account": "Account",
  "settings.account.row.lastChecked": "Last checked",
  "settings.account.row.diagnostics": "Diagnostic logs",
  "settings.account.value.notAvailable": "Not available",
  "settings.account.toast.refreshFailed.title": "Could not refresh account status",
  "settings.account.toast.signInFailed.title": "BharatCode sign-in failed",
  "settings.account.toast.signedIn.title": "Signed in to BharatCode",
  "settings.account.toast.signedIn.description": "Desktop will use this account for BharatCode model requests.",
  "settings.account.toast.exportFailed.title": "Could not export logs",
  "account.gate.description":
    "Sign in with your BharatCode account to connect this desktop app to the public beta model proxy. No API keys are required.",
  "account.gate.continue": "Continue with BharatCode",
  "account.gate.browser": "BharatCode opens your browser for secure account sign-in.",
  "account.gate.unavailable": "Could not check your BharatCode account. Refresh status to try again.",
  "settings.account.state.storageUnavailable.description":
    "Desktop could not check your BharatCode account on this device. Refresh status to try again.",
  "settings.account.action.signOut": "Sign out",
  "settings.account.action.signingOut": "Signing out...",
} as const
