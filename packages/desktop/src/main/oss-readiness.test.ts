import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const repoRoot = resolve(import.meta.dir, "../../../..")

async function readRepoFile(path: string) {
  return readFile(resolve(repoRoot, path), "utf8")
}

describe("Desktop OSS readiness", () => {
  test("does not expose a public dev release dispatch path", async () => {
    const workflow = await readRepoFile(".github/workflows/bharatcode-desktop-windows.yml")

    const dispatchOptions = workflow.match(/workflow_dispatch:[\s\S]*?tag:/)?.[0] ?? ""
    expect(dispatchOptions).toContain("- beta")
    expect(dispatchOptions).toContain("- prod")
    expect(dispatchOptions).not.toContain("- dev")
    expect(workflow).toContain("DEV builds are local-only and must not publish release assets.")
  })

  test("uses public-safe ownership and workflow language", async () => {
    const codeowners = await readRepoFile(".github/CODEOWNERS")
    const workflowReadme = await readRepoFile(".github/workflows/README.md")

    expect(codeowners).toContain("BharatCode Desktop repository ownership")
    expect(workflowReadme).toContain("BharatCode Desktop repository")
    expect(workflowReadme).toContain("bharatcode-desktop-linux.yml")
    expect(`${codeowners}\n${workflowReadme}`).not.toContain("private fork")
  })

  test("has a public Linux release workflow for AppImage and Debian packages", async () => {
    const workflow = await readRepoFile(".github/workflows/bharatcode-desktop-linux.yml")

    const dispatchOptions = workflow.match(/workflow_dispatch:[\s\S]*?tag:/)?.[0] ?? ""
    expect(dispatchOptions).toContain("- beta")
    expect(dispatchOptions).toContain("- prod")
    expect(dispatchOptions).not.toContain("- dev")
    expect(workflow).toContain("Refusing to publish dev-channel Linux artifacts.")
    expect(workflow).toContain("electron-builder --linux AppImage deb")
    expect(workflow).toContain("packages/desktop/dist/*.AppImage")
    expect(workflow).toContain("packages/desktop/dist/*.deb")
    expect(workflow).toContain("Upload Linux packages to GitHub Release")
  })

  test("makes Desktop first-run primary and classifies retained support areas", async () => {
    const readme = await readRepoFile("README.md")

    expect(readme).toContain("Desktop first-run opens BharatCode OAuth")
    expect(readme).toContain("CLI commands are optional bootstrap and troubleshooting tools")
    expect(readme).not.toContain("CLI-backed OAuth flow")
    for (const retainedArea of ["packages/effect-drizzle-sqlite", "packages/identity", "specs", "nix"]) {
      expect(readme).toContain(retainedArea)
    }
  })

  test("disables public web sharing in both Desktop server startup paths", async () => {
    const server = await readRepoFile("packages/desktop/src/main/server.ts")
    const sidecar = await readRepoFile("packages/desktop/src/main/sidecar.ts")

    expect(server).toContain('OPENCODE_DISABLE_SHARE: "1"')
    expect(sidecar).toContain('OPENCODE_DISABLE_SHARE: "1"')
  })
})
