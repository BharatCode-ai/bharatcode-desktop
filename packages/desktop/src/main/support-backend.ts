import { supportEvent, supportEvents, type SupportEvent } from "@opencode-ai/core/util/support-event"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"

export function createSupportBackend(now: () => number = Date.now) {
  let entries: SupportEvent[] = []
  let file: string | undefined
  let generation = 0
  const read = () => (entries = supportEvents(entries, now())).map((event) => ({ ...event }))
  const persist = () => {
    if (!file) return
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(read()), { flag: "wx", mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      // Disk failures must not break inference or the in-memory support export.
    } finally {
      try {
        unlinkSync(temporary)
      } catch {}
    }
  }
  return {
    configure(path: string) {
      file = path
      try {
        if (!lstatSync(path).isFile()) return
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const info = fstatSync(fd)
          if (!info.isFile() || info.size > 256 * 1024) return
          const bytes = Buffer.alloc(256 * 1024 + 1)
          const length = readSync(fd, bytes, 0, bytes.length, 0)
          if (length > 256 * 1024) return
          entries = supportEvents(JSON.parse(bytes.toString("utf8", 0, length)), now())
        } finally {
          closeSync(fd)
        }
      } catch {}
    },
    read,
    attach() {
      const owner = ++generation
      return {
        publish(value: unknown) {
          if (owner !== generation) return
          const event = supportEvent(value)
          if (!event) return
          entries.push(event)
          read()
          persist()
        },
        dispose() {
          if (owner === generation) generation++
        },
      }
    },
  }
}

export const supportBackend = createSupportBackend()
