#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { DISTRIBUTION, PLATFORM_TARGETS, createPlatformPackageManifest, platformPackageName } from "./distribution.mjs"
import { resolveWslBuildSourceSha } from "../src/server/wsl-desktop-transport"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const wslCandidate = process.argv.includes("--wsl-candidate")
const wslSourceSha = resolveWslBuildSourceSha(process.env, wslCandidate)
if (wslSourceSha !== "unavailable") {
  const head = (await $`git rev-parse HEAD`.quiet().text()).trim()
  const changes = (await $`git status --porcelain --untracked-files=normal`.quiet().text()).trim()
  if (head !== wslSourceSha || changes) throw new Error("WSL runtime identity requires the exact clean source checkout")
}

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const targets = singleFlag
  ? PLATFORM_TARGETS.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : PLATFORM_TARGETS

if (wslCandidate && !targets.some((item) => item.os === "linux" && !item.abi && item.avx2 !== false)) {
  throw new Error("WSL candidate requires a Linux glibc target")
}

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = platformPackageName(item)
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(DISTRIBUTION.packageName, "bun") as any,
      outfile: `dist/${name}/bin/${DISTRIBUTION.commandName}`,
      execArgv: [`--user-agent=${DISTRIBUTION.commandName}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "bharatcode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["bharatcode-web-ui.gen.ts"] : []),
    ],
    define: {
      BHARATCODE_WSL_COMPILED_SOURCE_SHA: JSON.stringify(wslSourceSha),
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/${DISTRIBUTION.commandName}`
    console.log(`Running smoke test: ${binaryPath} --version`)
    const smokeHome = await mkdtemp(path.join(tmpdir(), "bharatcode-build-smoke-"))
    try {
      const versionOutput = await $`${binaryPath} --version`
        .env({
          ...process.env,
          HOME: smokeHome,
          USERPROFILE: smokeHome,
          OPENCODE_TEST_HOME: smokeHome,
          XDG_DATA_HOME: path.join(smokeHome, "data"),
          XDG_STATE_HOME: path.join(smokeHome, "state"),
          XDG_CONFIG_HOME: path.join(smokeHome, "config"),
          XDG_CACHE_HOME: path.join(smokeHome, "cache"),
        })
        .text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      throw e
    } finally {
      await rm(smokeHome, { recursive: true, force: true })
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(createPlatformPackageManifest(item, Script.version), null, 2),
  )
  binaries[name] = Script.version

  if (wslCandidate && item.os === "linux" && !item.abi && item.avx2 !== false) {
    const filename = `bharatcode-runtime-linux-${item.arch}-glibc`
    const output = path.join(dir, "dist", `wsl-runtime-${item.arch}`)
    await mkdir(output)
    const runtimePath = path.join(output, filename)
    await copyFile(`dist/${name}/bin/${DISTRIBUTION.commandName}`, runtimePath)
    const bytes = new Uint8Array(await Bun.file(runtimePath).arrayBuffer())
    await chmod(runtimePath, 0o444)
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify({
        schema: 1,
        source_sha: wslSourceSha,
        version: Script.version,
        arch: item.arch,
        filename,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }) + "\n",
      { flag: "wx", mode: 0o444 },
    )
  }
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  // Building must not publish or overwrite assets. Cohort publication is a
  // separate, exact-source release workflow after all artifacts are verified.
}

export { binaries }
