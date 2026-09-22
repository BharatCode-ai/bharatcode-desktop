import type { BharatCodeAccountStatus } from "./platform"

export function createAccountStatusTracker() {
  let latest: BharatCodeAccountStatus | undefined
  return {
    snapshot: () => latest,
    failed(previous: BharatCodeAccountStatus | undefined) {
      if (latest !== previous) return latest
      latest = {
        ...latest,
        state: "connection_issue",
        authenticated: latest?.authenticated ?? false,
        checkedAt: new Date().toISOString(),
        message: undefined,
      }
      return latest
    },
    accept(next: BharatCodeAccountStatus | undefined) {
      if (
        !next ||
        (latest?.revision !== undefined && (next.revision === undefined || next.revision < latest.revision))
      ) {
        return latest
      }
      latest = next
      return latest
    },
  }
}
