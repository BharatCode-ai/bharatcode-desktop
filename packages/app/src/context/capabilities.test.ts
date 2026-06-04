import { describe, expect, test } from "bun:test"

import { mergeCapabilityRuntimeConfig } from "./capabilities"

describe("capability runtime config merge", () => {
  test("preserves user MCPs while applying BharatCode capabilities", () => {
    const next = mergeCapabilityRuntimeConfig(
      { mcp: { custom: { type: "local", command: ["custom-mcp"] } } } as { mcp: Record<string, unknown> },
      { skills: { paths: [] }, mcp: { github: { type: "remote", url: "https://api.githubcopilot.com/mcp/" } } },
    )

    expect(next.mcp?.custom).toEqual({ type: "local", command: ["custom-mcp"] })
    expect(next.mcp?.github).toEqual({ type: "remote", url: "https://api.githubcopilot.com/mcp/" })
  })

  test("removes managed MCPs when they are no longer in the runtime manifest", () => {
    const next = mergeCapabilityRuntimeConfig(
      {
        mcp: {
          custom: { type: "local", command: ["custom-mcp"] },
          github: { type: "remote", url: "https://api.githubcopilot.com/mcp/" },
        },
      } as { mcp: Record<string, unknown> },
      { skills: { paths: [] }, mcp: {} },
    )

    expect(next.mcp?.custom).toEqual({ type: "local", command: ["custom-mcp"] })
    expect(next.mcp?.github).toBeUndefined()
  })

  test("replaces managed skill paths without touching user skill paths", () => {
    const next = mergeCapabilityRuntimeConfig(
      {
        skills: {
          paths: ["/user/skills", "/bundle/superpowers/skills"],
        },
      },
      { skills: { paths: ["/new/superpowers/skills"] }, mcp: {} },
      { managedSkillPaths: ["/bundle/superpowers/skills"] },
    )

    expect(next.skills?.paths).toEqual(["/user/skills", "/new/superpowers/skills"])
  })

  test("removes stale managed Superpowers bundle paths", () => {
    const currentPath = "/home/ubuntu/bharatcode/apps/desktop/packages/desktop/resources/capabilities/superpowers/skills"
    const stalePath = "/home/ubuntu/resources/capabilities/superpowers/skills"

    const next = mergeCapabilityRuntimeConfig(
      {
        skills: {
          paths: ["/user/skills", stalePath, currentPath],
        },
      },
      { skills: { paths: [currentPath] }, mcp: {} },
    )

    expect(next.skills?.paths).toEqual(["/user/skills", currentPath])
  })
})
