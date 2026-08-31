import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises"
import path from "node:path"

/**
 * Publish namespace changes durably without trying to fsync Windows directories.
 * Windows uses MoveFileExW(MOVEFILE_WRITE_THROUGH), after regular-file fsync.
 * No COPY_ALLOWED, delayed move, or ignored native errors: cross-volume moves fail.
 * https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw
 */
export async function renameDurable(source: string, destination: string, replace = false) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || /\0/.test(source + destination))
    throw new Error("Durable migration paths must be absolute.")
  if (process.platform === "win32") {
    const { move, lastError, ptr } = await windowsMover()
    const from = Buffer.from(path.toNamespacedPath(source) + "\0", "utf16le")
    const to = Buffer.from(path.toNamespacedPath(destination) + "\0", "utf16le")
    if (move(ptr(from), ptr(to), 0x8 | (replace ? 0x1 : 0)) === 0) {
      const win32Code = lastError()
      const code =
        (
          {
            2: "ENOENT",
            3: "ENOENT",
            5: "EPERM",
            32: "EBUSY",
            80: "EEXIST",
            145: "ENOTEMPTY",
            183: "EEXIST",
          } as Record<number, string>
        )[win32Code] ?? "EIO"
      throw Object.assign(new Error("Windows could not durably publish the recovery data."), { code, win32Code })
    }
    return
  }
  if (
    !replace &&
    (await lstat(destination).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    ))
  )
    throw Object.assign(new Error("The recovery destination already exists."), { code: "EEXIST" })
  await rename(source, destination)
  for (const directory of new Set([path.dirname(source), path.dirname(destination)]))
    await syncPosixDirectory(directory)
}

export async function writeNewDurable(file: string, bytes: Uint8Array | string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // The final name is published only after the bytes have been flushed.
  const temporary = path.join(path.dirname(file), `.publish-${randomUUID()}`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, 0o600)
    await renameDurable(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function syncPosixDirectory(directory: string) {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function loadWindowsMover() {
  const { dlopen, ptr } = await import("bun:ffi")
  const library = dlopen("kernel32.dll", {
    MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  })
  return { move: library.symbols.MoveFileExW, lastError: library.symbols.GetLastError, ptr, library }
}
let windows: ReturnType<typeof loadWindowsMover> | undefined
function windowsMover() {
  return (windows ??= loadWindowsMover())
}
