import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import path from "path"
import os from "node:os"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

const preserveExerciseGlobalRoot = !!process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL ?? path.join(os.tmpdir(), `opencode-httpapi-global-${process.pid}`)
export const exerciseAuthProject = path.join(exerciseGlobalRoot, "auth-project")
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.OPENCODE_TEST_HOME = path.join(exerciseGlobalRoot, "home")
process.env.LOCALAPPDATA = path.join(exerciseGlobalRoot, "local")
process.env.APPDATA = path.join(exerciseGlobalRoot, "roaming")
process.env.OPENCODE_DISABLE_SHARE = "true"
const paths = StoragePaths.resolve({
  channel: process.env.BHARATCODE_CHANNEL,
  platform: process.platform,
  home: process.env.OPENCODE_TEST_HOME,
  temp: os.tmpdir(),
  env: process.env,
})
export const exerciseConfigDirectory = paths.config
export const exerciseDataDirectory = paths.data

const preserveExerciseDatabase = !!process.env.OPENCODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.OPENCODE_HTTPAPI_EXERCISE_DB ?? path.join(os.tmpdir(), `opencode-httpapi-exercise-${process.pid}.db`)
process.env.OPENCODE_DB = exerciseDatabasePath
Flag.OPENCODE_DB = exerciseDatabasePath

export const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
