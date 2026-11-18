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

import { identity, fixture } from "./fixtures/desktop-cohort"

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

test("CLI beta admission is explicit and does not weaken stable Desktop admission", () => {
  const source = {
    head: identity.source,
    tree: identity.tree,
    dirty: false,
    workflowSource: identity.source,
    desktopVersion: identity.version,
    cliVersion: identity.version,
  }
  const beta = { ...identity, channel: "beta" as const }
  expect(() => validateIdentity(beta, source)).toThrow()
  expect(validateIdentity(beta, source, { allowBeta: true })).toEqual(beta)
  expect(() => validateIdentity(beta, { ...source, dirty: true }, { allowBeta: true })).toThrow()
  expect(() => validateIdentity(beta, { ...source, head: "f".repeat(40) }, { allowBeta: true })).toThrow()
  expect(validateIdentity(identity, source)).toEqual(identity)
})

test("first stable candidate runs real upgrade checks for the same version as the bridge", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/publish.yml", import.meta.url)).text(),
  ) as { jobs: { package: { steps: Array<{ name?: string; if?: string }> } } }
  for (const platform of ["Windows", "Debian"]) {
    const step = workflow.jobs.package.steps.find((step: { name?: string }) =>
      step.name?.startsWith("Upgrade the actual public " + platform),
    )
    expect(step?.if).toContain("needs.admit.outputs.version == '" + identity.version + "'")
  }
  for (const script of ["windows.ps1", "debian.sh"])
    expect(
      await Bun.file(new URL("../../../script/desktop-stable-upgrade/" + script, import.meta.url)).text(),
    ).toContain(identity.version)
})

test("tested-release command binds the original run to a clean exact checkout, not the publishing workflow SHA", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-release-command-"))
  try {
    const repo = path.join(root, "repo")
    const input = path.join(root, "input")
    await fs.mkdir(repo)
    await fs.mkdir(input)
    const checkout = path.resolve(import.meta.dir, "../../..")
    const fromCheckout = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" })
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: fromCheckout("rev-parse", "--path-format=absolute", "--git-path", "objects"),
    }
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" })
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    // Share existing local Git objects; materialize only the two package
    // manifests. No synthetic commit, remote, install or full working copy.
    git("init", "--quiet")
    git("update-ref", "HEAD", fromCheckout("rev-parse", "HEAD"))
    git("sparse-checkout", "set", "--no-cone", "/packages/desktop/package.json", "/packages/opencode/package.json")
    git("read-tree", "-mu", "HEAD")
    const desktop = await Bun.file(path.join(repo, "packages/desktop/package.json")).json()
    const cli = await Bun.file(path.join(repo, "packages/opencode/package.json")).json()
    expect(cli.version).toBe(desktop.version)
    const value = {
      ...identity,
      version: desktop.version,
      source: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
    }
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
    expect(release.tag).toBe("desktop-1.15.50")
    expect(release.acceptance).toBe("pending")
    expect(release.publication).toBe("not-authorized")
    expect(release.candidateSha256).toBe(digest)
    expect(release.files).toHaveLength(11)
    const stable = path.join(output, "stable")
    const mac = Bun.YAML.parse(await fs.readFile(path.join(stable, "latest-mac.yml"), "utf8")) as {
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
      const content = await fs.readFile(path.join(stable, file.name))
      expect(content.length).toBe(file.bytes)
      expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256)
    }
    const sums = await fs.readFile(path.join(stable, "SHA256SUMS"), "utf8")
    expect(sums.trim().split("\n")).toHaveLength(12)
    expect(sums).toContain("  release-manifest.json\n")
    expect(await fs.readFile(path.join(stable, "bharatcode-desktop-mac-arm64.zip"))).toEqual(
      await fs.readFile(path.join(input, "darwin-arm64", "bharatcode-desktop-mac-arm64.zip")),
    )
    await fs.unlink(path.join(output, "compatibility/beta-mac.yml"))
    expect(await stageRelease(input, output, identity, digest)).toEqual(release)
    await fs.writeFile(path.join(output, "compatibility/beta-mac.yml"), "conflict")
    await expect(stageRelease(input, output, identity, digest)).rejects.toThrow()
    expect(await fs.readFile(path.join(output, "compatibility/beta-mac.yml"), "utf8")).toBe("conflict")
    expect(await fs.readFile(path.join(stable, "SHA256SUMS"), "utf8")).toBe(sums)
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
    expect(cohort.files).toHaveLength(12)
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
    expect((await assembleCohort(output, identity)).files).toHaveLength(12)
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
    await fs.rename(path.join(dir, "linux-x64-latest-linux.yml"), path.join(dir, "latest-linux.yml"))
    expect((await inspectPackageOutputs(dir, "linux-x64", identity)).map((file) => file.name)).toEqual([
      "bharatcode-desktop-linux-amd64.deb",
      "bharatcode-desktop-linux-x86_64.AppImage",
      "latest-linux.yml",
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
    { packages: { x64: { path: "https://example.invalid/web-installer" } } },
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

test("packaging rejects Linux metadata missing or misidentifying either install format", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-linux-formats-"))
  try {
    await fixture(root)
    const dir = path.join(root, "linux-x64")
    const file = path.join(dir, "latest-linux.yml")
    const raw = Bun.YAML.parse(await fs.readFile(path.join(dir, "linux-x64-latest-linux.yml"), "utf8")) as {
      version: string
      files: { url: string; size: number; sha512: string }[]
    }
    for (const entry of raw.files) {
      const others = raw.files.filter((item) => item !== entry)
      for (const files of [others, [...others, { ...entry, size: 1 }], [...others, { ...entry, sha512: "wrong" }]]) {
        await fs.writeFile(file, Bun.YAML.stringify({ version: raw.version, files }))
        await expect(inspectPackageOutputs(dir, "linux-x64", identity)).rejects.toThrow()
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
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
  expect(text).toContain("BHARATCODE_CHANNEL: prod")
  expect(text).not.toContain("inputs.channel")
  expect(text).toContain("if: inputs.acknowledge_unsigned_windows")
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

test("Windows-only candidate keeps exact-source WSL, skips full cohort and cannot relax publication completeness", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/publish.yml", import.meta.url)).text(),
  ) as {
    on: { workflow_dispatch: { inputs: { target: { default: string; options: string[] } } } }
    jobs: {
      admit: { steps: { id?: string; run?: string }[] }
      package: { needs: string[]; strategy: { matrix: string } }
      cohort: { if: string }
    }
  }
  expect(workflow.on.workflow_dispatch.inputs.target).toMatchObject({ default: "all", options: ["all", "windows-x64"] })
  expect(workflow.jobs.package.needs).toEqual(["admit", "wsl"])
  expect(workflow.jobs.package.strategy.matrix).toBe("${{ fromJSON(needs.admit.outputs.matrix) }}")
  expect(workflow.jobs.cohort.if).toBe("inputs.target == 'all' || inputs.target == ''")
  const script = workflow.jobs.admit.steps
    .find((step) => step.id === "targets")!
    .run!.match(/^bun -e '([\s\S]*)'\s*$/)![1]
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-targets-"))
  try {
    for (const target of ["all", "", "windows-x64", "invalid"]) {
      const output = path.join(root, target || "default")
      const result = spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, CANDIDATE_TARGET: target, GITHUB_OUTPUT: output },
        encoding: "utf8",
      })
      if (target === "invalid") {
        expect(result.status).not.toBe(0)
        continue
      }
      expect(result.status).toBe(0)
      const matrix = JSON.parse((await fs.readFile(output, "utf8")).trim().slice("matrix=".length)) as {
        include: { target: string; runner: string; arch: string }[]
      }
      expect(matrix.include.map((item) => item.target)).toEqual(
        target === "windows-x64" ? ["windows-x64"] : ["windows-x64", "darwin-arm64", "darwin-x64", "linux-x64"],
      )
      expect(matrix.include[0]).toEqual({ target: "windows-x64", runner: "windows-2022", arch: "x64" })
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
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
