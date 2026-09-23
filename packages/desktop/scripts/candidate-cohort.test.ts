import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, generateKeyPairSync } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  assembleCohort,
  collectCohort,
  inspectPackageOutputs,
  stageRelease,
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

async function fixture(root: string, value = identity) {
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
        version: value.version,
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
      identity: value,
      target,
      files,
      signing: target.startsWith("darwin") ? "apple-notarized-stapled" : "unsigned",
      verification: "package-build-only",
      acceptance: "pending",
    }
    await fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt))
  }
}

test("tested-release command binds the original run to a clean exact checkout, not the publishing workflow SHA", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-release-command-"))
  try {
    const repo = path.join(root, "repo")
    const input = path.join(root, "input")
    await fs.mkdir(repo)
    await fs.mkdir(input)
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    }
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" })
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    git("init", "--quiet")
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    )
    const value = { ...identity, source: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") }
    await fixture(input, value)
    const manifest = JSON.stringify(await assembleCohort(input, value))
    await fs.writeFile(path.join(input, "cohort.json"), manifest)
    const execute = (output: string, overrides: Record<string, string> = {}) =>
      spawnSync(
        process.execPath,
        [path.join(import.meta.dir, "stage-tested-release.ts"), input, path.join(root, output)],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...env,
            GITHUB_SHA: "f".repeat(40),
            GITHUB_OUTPUT: "",
            GITHUB_REPOSITORY: value.repository,
            SOURCE_SHA: value.source,
            SOURCE_RUN_ID: value.run,
            SOURCE_RUN_ATTEMPT: value.attempt,
            CANDIDATE_SHA256: createHash("sha256").update(manifest).digest("hex"),
            ...overrides,
          },
        },
      )
    expect(execute("wrong", { SOURCE_SHA: "a".repeat(40) }).status).not.toBe(0)
    expect(await fs.exists(path.join(root, "wrong"))).toBe(false)
    const success = execute("output")
    expect({ status: success.status, stderr: success.stderr }).toEqual({ status: 0, stderr: "" })
    expect(JSON.parse(success.stdout)).toMatchObject({ source: value.source, publication: "not-authorized" })
    await fs.writeFile(path.join(repo, "uncommitted"), "dirty")
    expect(execute("dirty").status).not.toBe(0)
    expect(await fs.exists(path.join(root, "dirty"))).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("release staging preserves tested bytes and merges both Mac updater architectures without claiming acceptance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-release-"))
  try {
    const input = path.join(root, "input")
    const output = path.join(root, "output")
    await fs.mkdir(input)
    await fixture(input)
    const manifest = JSON.stringify(await assembleCohort(input, identity))
    await fs.writeFile(path.join(input, "cohort.json"), manifest)
    const digest = createHash("sha256").update(manifest).digest("hex")
    const release = await stageRelease(input, output, identity, digest)
    expect(release.tag).toBe("desktop-beta-1.15.35")
    expect(release.acceptance).toBe("pending")
    expect(release.publication).toBe("not-authorized")
    expect(release.candidateSha256).toBe(digest)
    expect(release.files).toHaveLength(8)
    const mac = Bun.YAML.parse(await fs.readFile(path.join(output, "beta-mac.yml"), "utf8")) as {
      files: { url: string; sha512: string; size: number }[]
      path: string
      sha512: string
    }
    expect(mac.files.map((file) => file.url)).toEqual([
      "bharatcode-desktop-mac-x64.zip",
      "bharatcode-desktop-mac-arm64.zip",
    ])
    expect(mac.path).toBe(mac.files[0].url)
    expect(mac.sha512).toBe(mac.files[0].sha512)
    for (const file of release.files) {
      const content = await fs.readFile(path.join(output, file.name))
      expect(content.length).toBe(file.bytes)
      expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256)
    }
    const sums = await fs.readFile(path.join(output, "SHA256SUMS"), "utf8")
    expect(sums.trim().split("\n")).toHaveLength(9)
    expect(sums).toContain("  release-manifest.json\n")
    expect(await fs.readFile(path.join(output, "bharatcode-desktop-mac-arm64.zip"))).toEqual(
      await fs.readFile(path.join(input, "darwin-arm64", "bharatcode-desktop-mac-arm64.zip")),
    )
    await expect(stageRelease(input, output, identity, digest)).rejects.toThrow()
    expect(await fs.readFile(path.join(output, "SHA256SUMS"), "utf8")).toBe(sums)
    await expect(stageRelease(input, path.join(root, "wrong-hash"), identity, "0".repeat(64))).rejects.toThrow()
    await expect(
      stageRelease(input, path.join(root, "wrong-run"), { ...identity, run: "124" }, digest),
    ).rejects.toThrow()
    expect(await fs.readdir(root)).toEqual(["input", "output"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("release staging rejects unreceipted files, links, invented receipt assets and drift before creating output", async () => {
  for (const mutation of ["extra", "root-extra", "link", "invented", "drift", "manifest", "missing-updater-entry"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-release-"))
    try {
      const input = path.join(root, "input")
      const output = path.join(root, "output")
      await fs.mkdir(input)
      await fixture(input)
      const cohort = await assembleCohort(input, identity)
      const manifest = JSON.stringify(cohort)
      await fs.writeFile(path.join(input, "cohort.json"), manifest)
      const dir = path.join(input, "windows-x64")
      const installer = path.join(dir, "bharatcode-desktop-win-x64.exe")
      if (mutation === "extra") await fs.writeFile(path.join(dir, "unreceipted.exe"), "extra")
      if (mutation === "root-extra") await fs.writeFile(path.join(input, "unreceipted.exe"), "extra")
      if (mutation === "link") {
        await fs.rename(installer, path.join(root, "outside.exe"))
        await fs.link(path.join(root, "outside.exe"), installer)
      }
      if (mutation === "drift") await fs.appendFile(installer, "drift")
      if (mutation === "manifest") {
        cohort.identity = { ...cohort.identity, run: "999" }
        await fs.writeFile(path.join(input, "cohort.json"), JSON.stringify(cohort))
      }
      if (mutation === "invented" || mutation === "missing-updater-entry") {
        const receiptPath = path.join(dir, "receipt.json")
        const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Receipt
        if (mutation === "invented") {
          const content = Buffer.from("unexpected executable")
          await fs.writeFile(path.join(dir, "unexpected.exe"), content)
          receipt.files.push({
            name: "unexpected.exe",
            bytes: content.length,
            sha256: createHash("sha256").update(content).digest("hex"),
          })
        } else {
          const metadata = receipt.files.find((file) => file.name.endsWith(".yml"))!
          const content = Buffer.from(Bun.YAML.stringify({ version: identity.version, files: [] }))
          await fs.writeFile(path.join(dir, metadata.name), content)
          metadata.bytes = content.length
          metadata.sha256 = createHash("sha256").update(content).digest("hex")
        }
        await fs.writeFile(receiptPath, JSON.stringify(receipt))
      }
      await expect(
        stageRelease(input, output, identity, createHash("sha256").update(manifest).digest("hex")),
      ).rejects.toThrow()
      expect(await fs.exists(output)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

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

test("macOS candidate uses the configured repository signing and notarization secrets", async () => {
  const text = await Bun.file(new URL("../../../.github/workflows/publish.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(text) as {
    jobs: { package: { steps: { name?: string; env?: Record<string, string> }[] } }
  }
  const signing = workflow.jobs.package.steps.find((step) => step.name?.startsWith("Package macOS"))!
  expect(signing.env?.CSC_LINK).toBe("${{ secrets.CSC_LINK }}")
  expect(signing.env?.CSC_KEY_PASSWORD).toBe("${{ secrets.CSC_KEY_PASSWORD }}")
  expect(signing.env?.APPLE_KEY_CONTENT).toBe("${{ secrets.APPLE_API_KEY }}")
  expect(signing.env?.APPLE_API_KEY_ID).toBe("${{ secrets.APPLE_API_KEY_ID }}")
})

test("notarization key materialization accepts PEM/base64 and rejects invalid input or overwrite", async () => {
  const text = await Bun.file(new URL("../../../.github/workflows/publish.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(text) as {
    jobs: { package: { steps: { name?: string; run?: string }[] } }
  }
  const command = workflow.jobs.package.steps.find((step) => step.name?.startsWith("Package macOS"))!.run!
  const script = command.match(/node -e '([\s\S]*?)'/)?.[1]
  expect(script).toBeDefined()
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-notary-fixture-"))
  try {
    const target = path.join(root, "key.p8")
    const run = (content: string) =>
      spawnSync("node", ["--eval", script!], {
        env: { ...process.env, APPLE_KEY_CONTENT: content, APPLE_API_KEY: target },
        encoding: "utf8",
        timeout: 10_000,
      })
    for (const content of [pem.toString(), Buffer.from(pem).toString("base64")]) {
      expect(run(content).status).toBe(0)
      expect(await fs.readFile(target, "utf8")).toBe(pem.toString())
      if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
      expect(run(content).status).not.toBe(0)
      expect(await fs.readFile(target, "utf8")).toBe(pem.toString())
      await fs.unlink(target)
    }
    for (const content of ["", "not-a-private-key"]) {
      expect(run(content).status).not.toBe(0)
      expect(await fs.readdir(root)).toEqual([])
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
