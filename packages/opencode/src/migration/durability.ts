import { open } from "node:fs/promises"

export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
