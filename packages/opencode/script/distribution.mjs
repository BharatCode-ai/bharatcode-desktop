import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"

export const DISTRIBUTION = Object.freeze({
  packageName: "bharatcode",
  commandName: "bharatcode",
  binaryPathEnvironmentVariable: "BHARATCODE_BIN_PATH",
  repository: "BharatCode-ai/bharatcode-desktop",
})

/** @type {ReadonlyArray<Readonly<{os: string, arch: "arm64" | "x64", abi?: "musl", avx2?: false}>>} */
export const PLATFORM_TARGETS = Object.freeze(
  [
    { os: "linux", arch: "arm64" },
    { os: "linux", arch: "x64" },
    { os: "linux", arch: "x64", avx2: false },
    { os: "linux", arch: "arm64", abi: "musl" },
    { os: "linux", arch: "x64", abi: "musl" },
    { os: "linux", arch: "x64", abi: "musl", avx2: false },
    { os: "darwin", arch: "arm64" },
    { os: "darwin", arch: "x64" },
    { os: "darwin", arch: "x64", avx2: false },
    { os: "win32", arch: "arm64" },
    { os: "win32", arch: "x64" },
    { os: "win32", arch: "x64", avx2: false },
  ].map(Object.freeze),
)

const normalizePlatform = (platform) => (platform === "win32" ? "windows" : platform)

export function platformPackageName(target) {
  return [
    DISTRIBUTION.packageName,
    normalizePlatform(target.os),
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ]
    .filter(Boolean)
    .join("-")
}

export function platformBinaryName(platform) {
  return normalizePlatform(platform) === "windows" ? `${DISTRIBUTION.commandName}.exe` : DISTRIBUTION.commandName
}

function supportsAvx2(platform, arch) {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform !== "darwin") return false
  const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
  return result.status === 0 && result.stdout.trim() === "1"
}

function usesMusl(platform) {
  if (platform !== "linux") return false
  if (fs.existsSync("/etc/alpine-release")) return true
  const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
  return `${result.stdout}${result.stderr}`.toLowerCase().includes("musl")
}

export function hostDistributionTarget() {
  const platform = normalizePlatform(os.platform())
  const arch = os.arch()
  const base = platformPackageName({ os: platform, arch })
  const baseline = arch === "x64" && !supportsAvx2(platform, arch)
  const candidates =
    platform === "linux" && usesMusl(platform)
      ? arch === "x64"
        ? baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        : [`${base}-musl`, base]
      : arch === "x64"
        ? baseline
          ? [`${base}-baseline`, base]
          : [base, `${base}-baseline`]
        : [base]
  return { binary: platformBinaryName(platform), candidates, platform, arch }
}

export function createPlatformPackageManifest(target, version) {
  return {
    name: platformPackageName(target),
    version,
    repository: {
      type: "git",
      url: "git+https://github.com/BharatCode-ai/bharatcode-cli.git",
    },
    preferUnplugged: true,
    os: [target.os],
    cpu: [target.arch],
    files: ["bin"],
  }
}
