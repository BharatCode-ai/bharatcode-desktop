export const WSL_ACCEPTANCE_FLAG = "--bharatcode-wsl-acceptance-case"

const argumentNames = new Map([
  [WSL_ACCEPTANCE_FLAG, "case"],
  ["--runtime-manifest", "runtimeManifest"],
  ["--distribution", "distribution"],
  ["--invalid-distribution", "invalidDistribution"],
  ["--missing-prerequisite-distribution", "missingPrerequisiteDistribution"],
  ["--windows-project", "windowsProject"],
  ["--source-sha", "sourceSha"],
  ["--acceptance-dir", "acceptanceDirectory"],
] as const)

export interface WslAcceptanceInput {
  readonly acceptanceDirectory: string
  readonly case: "scenario-9" | "scenario-10"
  readonly distribution: string
  readonly invalidDistribution: string
  readonly missingPrerequisiteDistribution: string
  readonly runtimeManifest: string
  readonly sourceSha: string
  readonly windowsProject: string
}

export type WslAcceptanceDispatch =
  | { readonly kind: "ordinary" }
  | { readonly kind: "acceptance"; readonly input: WslAcceptanceInput }

export function resolveWslAcceptanceInvocation(
  argv: readonly string[],
  environment: { readonly packaged: boolean; readonly platform: string },
): WslAcceptanceDispatch {
  if (!argv.includes(WSL_ACCEPTANCE_FLAG)) return { kind: "ordinary" }
  if (!environment.packaged || environment.platform !== "win32") {
    throw new Error("Packaged WSL acceptance is unavailable")
  }
  if (argv.length !== argumentNames.size * 2) throw new Error("Malformed packaged WSL acceptance invocation")

  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argumentNames.get(argv[index] as never)
    const value = argv[index + 1]
    if (!name || !value || values.has(name) || /[\0\r\n]/u.test(value)) {
      throw new Error("Malformed packaged WSL acceptance invocation")
    }
    values.set(name, value)
  }

  const caseName = values.get("case")
  const sourceSha = values.get("sourceSha")
  if ((caseName !== "scenario-9" && caseName !== "scenario-10") || !sourceSha?.match(/^[0-9a-f]{40}$/u)) {
    throw new Error("Malformed packaged WSL acceptance invocation")
  }

  return {
    kind: "acceptance",
    input: {
      acceptanceDirectory: values.get("acceptanceDirectory")!,
      case: caseName,
      distribution: values.get("distribution")!,
      invalidDistribution: values.get("invalidDistribution")!,
      missingPrerequisiteDistribution: values.get("missingPrerequisiteDistribution")!,
      runtimeManifest: values.get("runtimeManifest")!,
      sourceSha,
      windowsProject: values.get("windowsProject")!,
    },
  }
}

export async function runPackagedWslAcceptance(_input: WslAcceptanceInput): Promise<string> {
  throw new Error("Packaged WSL acceptance adapter is unavailable")
}
