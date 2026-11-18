#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const [binaryArg, extensionArg, licenseArg] = process.argv.slice(2)
if (!binaryArg || !extensionArg || !licenseArg) {
  throw new Error("Usage: bun scripts/stage-browse.ts <native Browse executable> <extension dist> <Browse LICENSE>")
}

const binary = resolve(binaryArg)
const extension = resolve(extensionArg)
const manifest = await Bun.file(join(extension, "manifest.json")).json()
if (manifest.name !== "BharatCode Browse" || manifest.manifest_version !== 3) {
  throw new Error("Expected a built BharatCode Browse extension")
}
const resources = resolve(import.meta.dir, "../resources")
await mkdir(resources, { recursive: true })
const temporary = await mkdtemp(join(resources, ".browse-stage-"))
const filename = process.platform === "win32" ? "browse.exe" : "browse"
try {
  await cp(binary, join(temporary, filename))
  await cp(extension, join(temporary, "extension"), {
    recursive: true,
    filter: (source) => source !== join(extension, "relay-pairing.json"),
  })
  await cp(resolve(licenseArg), join(temporary, "LICENSE"))
  const hash = createHash("sha256")
  for await (const chunk of Bun.file(binary).stream()) hash.update(chunk)
  for (const file of Array.from(new Bun.Glob("**/*").scanSync(join(temporary, "extension"))).sort()) {
    hash.update(file)
    hash.update(
      await Bun.file(join(temporary, "extension", file))
        .arrayBuffer()
        .then(Buffer.from),
    )
  }
  await Bun.write(join(temporary, "bundle-id"), hash.digest("hex"))
  const target = join(resources, "bharatcode-browse")
  await rm(target, { recursive: true, force: true })
  await rename(temporary, target)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
