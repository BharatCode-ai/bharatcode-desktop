import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const repoRoot = resolve(import.meta.dir, "../../../..")

async function readRepoFile(path: string) {
  return readFile(resolve(repoRoot, path), "utf8")
}

describe("Desktop OSS readiness", () => {
  test("does not expose a public dev release dispatch path", async () => {
    const workflow = await readRepoFile(".github/workflows/bharatcode-next-beta-candidate.yml")
    expect(workflow).toContain("BHARATCODE_CHANNEL: beta")
    expect(workflow).not.toContain("gh release create")
    expect(workflow).not.toContain("contents: write")
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
    const workflow = await readRepoFile(".github/workflows/bharatcode-next-beta-candidate.yml")
    const publish = await readRepoFile(".github/workflows/bharatcode-publish-tested-candidate.yml")
    expect(workflow).toContain("electron-builder --linux AppImage deb")
    expect(workflow).toContain("bharatcode-desktop-next-beta-linux-x64.AppImage")
    expect(workflow).toContain("bharatcode-desktop-next-beta-linux-x64.deb")
    expect(publish).toContain("inputs.manual_acceptance_confirmed")
    expect(publish).toContain("gh release upload")
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

  test("enables public web sharing only through BharatCode in Desktop startup paths", async () => {
    const main = await readRepoFile("packages/desktop/src/main/index.ts")
    const server = await readRepoFile("packages/desktop/src/main/server.ts")
    const sidecar = await readRepoFile("packages/desktop/src/main/sidecar.ts")

    expect(main).not.toContain("OPENCODE_DISABLE_SHARE")

    for (const source of [server, sidecar]) {
      expect(source).toContain("BHARATCODE_SHARE_BASE_URL")
      expect(source).toContain("https://bharatcode.ai")
      expect(source).not.toContain("OPENCODE_DISABLE_SHARE")
    }
    expect(server).toContain("shellEnv?.BHARATCODE_SHARE_BASE_URL")
  })
})
