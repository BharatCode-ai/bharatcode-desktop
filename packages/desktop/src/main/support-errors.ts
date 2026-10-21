import { supportErrorCategories, type SupportErrorCategory, type SupportErrorSummary } from "./support-bundle"

export function createSupportErrors(now: () => number = Date.now) {
  const entries: { category: SupportErrorCategory; time: number }[] = []
  const prune = () => {
    const cutoff = now() - 24 * 60 * 60 * 1000
    while (entries.length && entries[0].time <= cutoff) entries.shift()
    if (entries.length > 200) entries.splice(0, entries.length - 200)
  }
  return {
    record(this: void, category: SupportErrorCategory) {
      if (!supportErrorCategories.includes(category)) return
      entries.push({ category, time: now() })
      prune()
    },
    summary(): SupportErrorSummary {
      prune()
      const counts: SupportErrorSummary = {
        startup: 0,
        sidecar: 0,
        authentication: 0,
        database: 0,
        update: 0,
        network: 0,
        renderer: 0,
        other: 0,
      }
      entries.forEach((entry) => {
        counts[entry.category]++
      })
      return counts
    },
  }
}

export const supportErrors = createSupportErrors()
