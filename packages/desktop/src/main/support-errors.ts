import { supportErrorCategories, type SupportErrorCategory, type SupportErrorSummary } from "./support-bundle"

export function createSupportErrors(now: () => number = Date.now) {
  const entries: { category: SupportErrorCategory; time: number }[] = []
  const prune = () => {
    const cutoff = now() - 24 * 60 * 60 * 1000
    while (entries.length && entries[0].time <= cutoff) entries.shift()
    if (entries.length > 200) entries.splice(0, entries.length - 200)
  }
  return {
    record(category: SupportErrorCategory) {
      if (!supportErrorCategories.includes(category)) return
      entries.push({ category, time: now() })
      prune()
    },
    summary(): SupportErrorSummary {
      prune()
      return Object.fromEntries(supportErrorCategories.map((category) => [category, entries.filter((entry) => entry.category === category).length])) as SupportErrorSummary
    },
  }
}

export const supportErrors = createSupportErrors()
