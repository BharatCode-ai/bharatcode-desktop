import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    // The directory is named for the product and channel now, not "opencode",
    // so assert the invariant rather than the literal name.
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), StoragePaths.displayName(Global.make().channel)))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
