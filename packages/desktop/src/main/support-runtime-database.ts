import { createSupportBundle, type SupportMetadata } from "./support-bundle"

export function createRuntimeDatabaseMetadata() {
  let generation = 0
  let snapshot: SupportMetadata["database"] | undefined
  return {
    read() {
      return snapshot ? { ...snapshot } : undefined
    },
    attach() {
      const owner = ++generation
      snapshot = undefined
      return {
        publish(value: unknown) {
          if (owner !== generation) return
          const metadata = createSupportBundle({ database: value }).database
          snapshot =
            metadata.source === "runtime_snapshot" &&
            metadata.availability === "available" &&
            metadata.capturedAt !== null &&
            metadata.schemaVersion !== null &&
            metadata.appliedCount !== null
              ? metadata
              : undefined
        },
        dispose() {
          if (owner === generation) {
            snapshot = undefined
            generation++
          }
        },
      }
    },
  }
}

export const supportRuntimeDatabase = createRuntimeDatabaseMetadata()
