import { randomUUID } from "node:crypto"
import { rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js"
import { createSupportBundle, type SupportBundleInput } from "./support-bundle"

export function createSupportExporter(options: {
  directory: () => string
  input: () => SupportBundleInput | Promise<SupportBundleInput>
  reveal: (filename: string) => unknown
  failure: () => Error
}) {
  let pending: Promise<string> | undefined
  const save = async () => {
    const input = await Promise.resolve()
      .then(options.input)
      .catch(() => ({}))
    const generated = new Date().toISOString()
    const document = createSupportBundle({ ...input, generated })
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add("support-bundle.json", new TextReader(JSON.stringify(document, null, 2)))
    const bytes = await writer.close()
    const output = join(
      options.directory(),
      `bharatcode-support-${generated.replace(/[:.]/g, "-")}-${randomUUID()}.zip`,
    )
    const temporary = `${output}.tmp`
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
      await rename(temporary, output)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    // Revealing a saved file is a convenience, not a condition of a successful save.
    await Promise.resolve()
      .then(() => options.reveal(output))
      .catch(() => undefined)
    return output
  }
  return function exportSupportBundle() {
    return (pending ??= save()
      .catch(() => {
        throw options.failure()
      })
      .finally(() => {
        pending = undefined
      }))
  }
}

export function supportExportAction(options: {
  owned: (id: number) => boolean
  run: () => Promise<string>
  failure: () => Error
}) {
  return async (event: { sender: { id: number; mainFrame: unknown }; senderFrame: unknown }) => {
    if (!options.owned(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw options.failure()
    return options.run().catch(() => {
      throw options.failure()
    })
  }
}
