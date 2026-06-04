import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { createResource } from "solid-js"

import { useGlobalSync } from "./global-sync"
import { useLanguage } from "./language"
import {
  type CapabilityRuntimeManifest,
  type CapabilitySnapshot,
  usePlatform,
} from "./platform"

type RuntimeConfig = {
  skills?: {
    paths?: string[]
    [key: string]: unknown
  }
  mcp?: Record<string, unknown>
  [key: string]: unknown
}

const EMPTY_SNAPSHOT: CapabilitySnapshot = {
  catalog: [],
  state: { version: 1, installed: {} },
  runtime: { skills: { paths: [] }, mcp: {} },
}

const MANAGED_MCP_NAMES = [
  "github",
  "playwright",
  "figma",
  "linear",
  "sentry",
  "supabase",
  "stripe",
  "cloudflare-docs",
]

function isManagedSkillPath(path: string, managedSkillPaths: Set<string>) {
  if (managedSkillPaths.has(path)) return true
  return path.replace(/\\/g, "/").endsWith("/resources/capabilities/superpowers/skills")
}

export function mergeCapabilityRuntimeConfig<T extends RuntimeConfig>(
  config: T,
  runtime: CapabilityRuntimeManifest,
  options: { managedSkillPaths?: string[] } = {},
): T {
  const managedMcpNames = new Set(MANAGED_MCP_NAMES)
  const currentMcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp) ? config.mcp : {}
  const mcp: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(currentMcp)) {
    if (!managedMcpNames.has(name)) mcp[name] = value
  }
  for (const [name, value] of Object.entries(runtime.mcp)) {
    mcp[name] = value
  }

  const currentSkills =
    config.skills && typeof config.skills === "object" && !Array.isArray(config.skills) ? config.skills : {}
  const currentPaths = Array.isArray(currentSkills.paths)
    ? currentSkills.paths.filter((item): item is string => typeof item === "string")
    : []
  const runtimePaths = runtime.skills.paths
  const managedSkillPaths = new Set([...runtimePaths, ...(options.managedSkillPaths ?? [])])
  const skills = {
    ...currentSkills,
    paths: [...new Set([...currentPaths.filter((item) => !isManagedSkillPath(item, managedSkillPaths)), ...runtimePaths])],
  }

  return {
    ...config,
    skills,
    mcp,
  }
}

export const { use: useCapabilities, provider: CapabilitiesProvider } = createSimpleContext({
  name: "Capabilities",
  init: () => {
    const platform = usePlatform()
    const globalSync = useGlobalSync()
    const language = useLanguage()
    const [snapshot, { mutate, refetch }] = createResource(
      () => platform.getCapabilitySnapshot?.() ?? Promise.resolve(EMPTY_SNAPSHOT),
      { initialValue: EMPTY_SNAPSHOT },
    )

    const applyRuntime = async (next: CapabilitySnapshot) => {
      mutate(next)
      await platform.applyCapabilityRuntime?.().catch(() => undefined)
      await globalSync.updateConfig(mergeCapabilityRuntimeConfig(globalSync.data.config, next.runtime) as any)
      return next
    }

    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: message,
      })
      throw error
    }

    return {
      snapshot,
      refetch,
      install: (id: string) =>
        (platform.installCapability?.(id) ?? Promise.resolve(snapshot.latest)).then(applyRuntime).catch(fail),
      setEnabled: (id: string, enabled: boolean) =>
        (platform.setCapabilityEnabled?.(id, enabled) ?? Promise.resolve(snapshot.latest))
          .then(applyRuntime)
          .catch(fail),
      uninstall: (id: string) =>
        (platform.uninstallCapability?.(id) ?? Promise.resolve(snapshot.latest)).then(applyRuntime).catch(fail),
    }
  },
})
