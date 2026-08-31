import { spawnSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { windowsCredentialStore } from "@opencode-ai/core/util/windows-credential-store"

// Quarantine uses the same retained native ancestor/leaf authority as private
// publication, not pathname MoveFileEx after releasing lstat/read handles.
export function quarantineWindowsMarker(source: string, destination: string, spawn = spawnSync) {
  const identity = lstatSync(source, { bigint: true }).ino.toString()
  windowsCredentialStore(source, { spawn }).quarantineMarker(destination, identity)
}
