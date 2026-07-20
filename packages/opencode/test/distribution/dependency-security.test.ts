import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import pkg from "../../package.json"

const patchedMinimatch = "10.2.5"
const repositoryRoot = resolve(import.meta.dir, "../../../..")

type Lockfile = {
  workspaces: Record<string, { dependencies?: Record<string, string> }>
  packages: Record<string, [string, ...unknown[]]>
}

describe("BharatCode runtime dependency security", () => {
  test("resolves the direct minimatch dependency to the patched shared package", async () => {
    const lock = Bun.JSONC.parse(await Bun.file(resolve(repositoryRoot, "bun.lock")).text()) as Lockfile

    expect(pkg.dependencies.minimatch).toBe(patchedMinimatch)
    expect(lock.workspaces["packages/opencode"].dependencies?.minimatch).toBe(patchedMinimatch)
    expect(lock.packages.minimatch?.[0]).toBe(`minimatch@${patchedMinimatch}`)
    expect(lock.packages["bharatcode/minimatch"]).toBeUndefined()
    expect(Object.entries(lock.packages).filter(([, value]) => value[0] === "minimatch@10.0.3")).toEqual([])
  })
})
