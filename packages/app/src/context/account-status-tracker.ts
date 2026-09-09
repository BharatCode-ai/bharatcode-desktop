import type { BharatCodeAccountStatus } from "./platform"

export function createAccountStatusTracker() {
  let latest: BharatCodeAccountStatus | undefined
  return {
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
