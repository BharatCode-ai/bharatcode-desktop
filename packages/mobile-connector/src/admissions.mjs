import { readFile, writeFile, rename, chmod } from "node:fs/promises"
import { randomUUID } from "node:crypto"

const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
const invalid = message => Object.assign(new Error(message), { code: "INVALID_ADMISSIONS", mobileStorage: true })

async function recoveryBefore(path) {
  try {
    const value = JSON.parse(await readFile(path + ".recovery", "utf8"))
    if (!record(value) || !Number.isSafeInteger(value.before) || value.before < 0)
      throw invalid("Invalid mobile admission recovery boundary")
    return value.before
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    if (error instanceof SyntaxError) throw invalid("Invalid mobile admission recovery boundary")
    error.mobileStorage = true
    throw error
  }
}

async function journal(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"))
    if (!record(value) || !record(value.admissions) || !record(value.selections) ||
      Object.entries(value.admissions).some(([key, item]) =>
        !/^[A-Za-z0-9_-]+\.msg_[A-Za-z0-9_-]+$/.test(key) || !record(item) ||
        !/^[a-f0-9]{64}$/.test(item.hash) || !["forwarding", "admitted"].includes(item.state)) ||
      Object.values(value.selections).some(item => !record(item)) ||
      (value.recoverySessions !== undefined && (!Array.isArray(value.recoverySessions) ||
        value.recoverySessions.some(id => typeof id !== "string" || !/^ses_[a-f0-9]{32}$/.test(id)))))
      throw invalid("Invalid mobile admission journal")
    return value
  } catch (error) {
    if (error.code === "ENOENT") return { admissions: {}, selections: {} }
    if (error instanceof SyntaxError) throw invalid("Invalid mobile admission journal")
    error.mobileStorage = true
    throw error
  }
}

export async function openAdmissions(path) {
  const before = await recoveryBefore(path)
  return { state: await journal(path), recovered: before !== undefined }
}

// Reset never discards a healthy journal: it may contain an uncertain delivery.
// Persist the fence BEFORE quarantine so a crash cannot reopen an empty journal
// without its duplicate-delivery protection. Healthy resets leave it unchanged;
// another corrupt journal must fence deliveries made since the previous recovery.
export async function resetAdmissions(path) {
  const before = await recoveryBefore(path)
  try {
    await journal(path)
    return
  } catch (error) {
    if (error.code !== "INVALID_ADMISSIONS") throw error
  }
  try {
    const temporary = path + ".recovery." + randomUUID()
    await writeFile(temporary, JSON.stringify({ before: Math.max(before ?? 0, Date.now()) }), { flag: "wx", mode: 0o600 })
    await rename(temporary, path + ".recovery")
    // A damaged file can contain previous selections; keep its backup private.
    await chmod(path, 0o600)
    await rename(path, path + ".corrupt-" + randomUUID())
  } catch (error) {
    error.mobileStorage = true
    throw error
  }
}
