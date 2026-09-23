import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  assembleCohort,
  collectCohort,
  inspectPackageOutputs,
  validateIdentity,
  type Receipt,
} from "./candidate-cohort"

const identity = {
  source: "a".repeat(40),
  tree: "b".repeat(40),
  version: "1.15.35",
  channel: "beta" as const,
  repository: "BharatCode-ai/bharatcode-desktop",
  run: "123",
  attempt: "1",
}

test("candidate admission binds the workflow, checkout, committed versions and run", () => {
  expect(
    validateIdentity(identity, {
      head: identity.source,
      tree: identity.tree,
      dirty: false,
      workflowSource: identity.source,
      desktopVersion: identity.version,
      cliVersion: identity.version,
    }),
  ).toEqual(identity)
  for (const change of [
    { head: "c".repeat(40) },
    { tree: "c".repeat(40) },
    { dirty: true },
    { workflowSource: "c".repeat(40) },
    { desktopVersion: "1.15.34" },
    { cliVersion: "1.15.34" },
  ])
    expect(() =>
      validateIdentity(identity, {
        head: identity.source,
        tree: identity.tree,
        dirty: false,
        workflowSource: identity.source,
        desktopVersion: identity.version,
        cliVersion: identity.version,
        ...change,
      }),
    ).toThrow()
  expect(() =>
    validateIdentity(
      { ...identity, repository: "anomalyco/opencode" },
      {
        head: identity.source,
        tree: identity.tree,
        dirty: false,
        workflowSource: identity.source,
        desktopVersion: identity.version,
        cliVersion: identity.version,
      },
    ),
  ).toThrow()
})

async function fixture(root: string) {
  const targets = ["windows-x64", "darwin-x64", "darwin-arm64", "linux-x64"] as const
  for (const target of targets) {
    const dir = path.join(root, target)
    await fs.mkdir(dir)
    const suffixes = target === "windows-x64" ? ["exe"] : target.startsWith("darwin") ? ["zip"] : ["AppImage", "deb"]
    const files: Receipt["files"] = []
    for (const ext of suffixes) {
      const platform =
        target === "linux-x64"
          ? `linux-${ext === "deb" ? "amd64" : "x86_64"}`
          : target.replace("windows", "win").replace("darwin", "mac")
      const name = `bharatcode-desktop-${platform}.${ext}`
      const bytes = Buffer.from(`synthetic ${target} ${ext}`)
      await fs.writeFile(path.join(dir, name), bytes)
      files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
    }
    const metadataName = `${target}-beta${target.startsWith("darwin") ? "-mac" : target === "linux-x64" ? "-linux" : ""}.yml`
    const artifact = await fs.readFile(path.join(dir, files[0].name))
    const metadata = Buffer.from(
      Bun.YAML.stringify({
        version: identity.version,
        files: [
          {
            url: files[0].name,
            size: artifact.length,
            sha512: createHash("sha512").update(artifact).digest("base64"),
          },
        ],
      }),
    )
    await fs.writeFile(path.join(dir, metadataName), metadata)
    files.push({
      name: metadataName,
      bytes: metadata.length,
      sha256: createHash("sha256").update(metadata).digest("hex"),
    })
    const receipt: Receipt = {
      schema: 1,
      identity,
      target,
      files,
      signing: target.startsWith("darwin") ? "apple-notarized-stapled" : "unsigned",
      verification: "package-build-only",
      acceptance: "pending",
    }
    await fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt))
  }
}

test("cohort requires every architecture, exact source/run and immutable verified bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cohort-"))
  try {
    await fixture(root)
    const cohort = await assembleCohort(root, identity)
    expect(cohort.files).toHaveLength(9)
    expect(cohort.acceptance).toBe("pending")
    expect(cohort.publication).toBe("not-authorized")
    await fs.appendFile(path.join(root, "linux-x64", "bharatcode-desktop-linux-amd64.deb"), "drift")
    await expect(assembleCohort(root, identity)).rejects.toThrow()
    await fs.rm(path.join(root, "darwin-arm64"), { recursive: true })
    await expect(assembleCohort(root, identity)).rejects.toThrow()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("download collection rejects missing, extra and stale-attempt producers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cohort-"))
  try {
    await fixture(root)
    for (const target of await fs.readdir(root))
      await fs.rename(path.join(root, target), path.join(root, `candidate-${target}-123-1`))
    await fs.mkdir(path.join(root, "candidate-linux-x64-123-2"))
    await expect(collectCohort(root, identity)).rejects.toThrow()
    await fs.rmdir(path.join(root, "candidate-linux-x64-123-2"))
    const output = await collectCohort(root, identity)
    expect((await assembleCohort(output, identity)).files).toHaveLength(9)
    await expect(collectCohort(root, identity)).rejects.toThrow()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("producer inspection recognizes native Linux aliases and validates updater bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cohort-"))
  try {
    await fixture(root)
    const dir = path.join(root, "linux-x64")
    await fs.rename(path.join(dir, "linux-x64-beta-linux.yml"), path.join(dir, "beta-linux.yml"))
    expect((await inspectPackageOutputs(dir, "linux-x64", identity)).map((file) => file.name)).toEqual([
      "beta-linux.yml",
      "bharatcode-desktop-linux-amd64.deb",
      "bharatcode-desktop-linux-x86_64.AppImage",
    ])
    await expect(inspectPackageOutputs(dir, "linux-x64", { ...identity, version: "1.0.0" })).rejects.toThrow()
    await fs.rename(
      path.join(dir, "bharatcode-desktop-linux-amd64.deb"),
      path.join(dir, "bharatcode-desktop-linux-x64.deb"),
    )
    await expect(inspectPackageOutputs(dir, "linux-x64", identity)).rejects.toThrow()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("updater metadata cannot redirect outside or misidentify packaged bytes", async () => {
  for (const change of [
    { version: "1.0.0" },
    { files: [] },
    { files: [{ url: "../outside.zip" }] },
    { path: "../outside.zip", sha512: "invalid" },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cohort-"))
    try {
      await fixture(root)
      const dir = path.join(root, "darwin-x64")
      const receiptPath = path.join(dir, "receipt.json")
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Receipt
      const file = receipt.files.find((file) => file.name.endsWith(".yml"))!
      const content = Buffer.from(
        Bun.YAML.stringify({
          ...(Bun.YAML.parse(await fs.readFile(path.join(dir, file.name), "utf8")) as object),
          ...change,
        }),
      )
      await fs.writeFile(path.join(dir, file.name), content)
      file.bytes = content.length
      file.sha256 = createHash("sha256").update(content).digest("hex")
      await fs.writeFile(receiptPath, JSON.stringify(receipt))
      await expect(assembleCohort(root, identity)).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test("cohort rejects forged policy, mixed source, missing member and traversal", async () => {
  for (const mutate of [
    (r: Receipt) => ({ ...r, signing: "unsigned" }),
    (r: Receipt) => ({ ...r, identity: { ...identity, source: "c".repeat(40) } }),
    (r: Receipt) => ({ ...r, identity: { ...identity, attempt: "2" } }),
    (r: Receipt) => ({ ...r, files: [] }),
    (r: Receipt) => ({ ...r, files: [{ ...r.files[0], name: "../outside.zip" }] }),
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cohort-"))
    try {
      await fixture(root)
      const file = path.join(root, "darwin-x64", "receipt.json")
      await fs.writeFile(file, JSON.stringify(mutate(JSON.parse(await fs.readFile(file, "utf8")))))
      await expect(assembleCohort(root, identity)).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test("candidate workflow is manual, read-only, exact-checkout and never publishes", async () => {
  const text = await Bun.file(new URL("../../../.github/workflows/publish.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(text) as Record<string, unknown>
  expect(Object.keys(workflow.on as object)).toEqual(["workflow_dispatch"])
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(text).not.toMatch(/Azure|AZURE_|gh release|npm publish|--clobber|--force|blacksmith|packages\/cli/)
  expect(text).toContain("--publish never")
  expect(text).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"')
  expect(text).toContain("--wsl-candidate")
  expect(text).toContain("assemble")
})
