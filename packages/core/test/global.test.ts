import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the BharatCode system temp directory", () => {
    expect(Global.Path.tmp).toStartWith(path.join(os.tmpdir(), "bharatcode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created only through explicit activation", async () => {
    await Global.ensure()
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("uses only the BharatCode config override", () => {
    const previousLegacy = process.env.OPENCODE_CONFIG_DIR
    const previousBranded = process.env.BHARATCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = "/legacy-config"
    process.env.BHARATCODE_CONFIG_DIR = "/bharatcode-config"
    try {
      expect(Global.make().config).toBe("/bharatcode-config")
    } finally {
      if (previousLegacy === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousLegacy
      if (previousBranded === undefined) delete process.env.BHARATCODE_CONFIG_DIR
      else process.env.BHARATCODE_CONFIG_DIR = previousBranded
    }
  })
})
