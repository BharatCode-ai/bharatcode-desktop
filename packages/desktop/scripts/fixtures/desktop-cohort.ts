import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { assembleCohort, stageRelease, type Receipt } from "../candidate-cohort"

export const identity = {
  source: "a".repeat(40),
  tree: "b".repeat(40),
  version: "1.15.50",
  channel: "prod" as const,
  repository: "BharatCode-ai/bharatcode-desktop",
  run: "123",
  attempt: "1",
}

export async function fixture(root: string, value = identity) {
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
    if (target !== "linux-x64") {
      const map = gzipSync(
        JSON.stringify({ version: "2", files: [{ name: target, offset: 0, checksums: [], sizes: [] }] }),
      )
      const name = files[0].name + ".blockmap"
      await fs.writeFile(path.join(dir, name), map)
      files.push({ name, bytes: map.length, sha256: createHash("sha256").update(map).digest("hex") })
    }
    const metadataName = `${target}-latest${target.startsWith("darwin") ? "-mac" : target === "linux-x64" ? "-linux" : ""}.yml`
    const entries = await Promise.all(
      files
        .filter((file) => !file.name.endsWith(".blockmap"))
        .map(async (file) => ({
          url: file.name,
          size: file.bytes,
          sha512: createHash("sha512")
            .update(await fs.readFile(path.join(dir, file.name)))
            .digest("base64"),
        })),
    )
    const metadata = Buffer.from(
      Bun.YAML.stringify({
        version: value.version,
        path: entries[0].url,
        sha512: entries[0].sha512,
        files: entries,
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

export async function stageFixture(root: string, version = identity.version) {
  const input = path.join(root, "input")
  const output = path.join(root, "staged")
  const value = { ...identity, version }
  await fs.mkdir(input)
  await fixture(input, value)
  const manifest = JSON.stringify(await assembleCohort(input, value))
  await fs.writeFile(path.join(input, "cohort.json"), manifest)
  const release = await stageRelease(input, output, value, createHash("sha256").update(manifest).digest("hex"))
  return { release, output }
}
