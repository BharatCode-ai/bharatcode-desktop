# BharatCode Capability Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first-party BharatCode Desktop Capability Marketplace with bundled Superpowers by Obra, curated developer capabilities, install state, engine adapter, Settings UI, and verification.

**Architecture:** The Electron main process owns the Capability Layer and persists install state in a BharatCode-specific store. The renderer accesses it through platform IPC and shows Settings > Marketplace. The engine adapter derives the hidden OpenCode runtime config from the BharatCode capability manifest, patches the config before sidecar startup, and returns runtime patches for live UI updates.

**Tech Stack:** Electron main/preload, SolidJS renderer, TypeScript, `electron-store`, existing OpenCode config APIs, Bun tests, existing app settings/status components.

---

## File Structure

- Create `packages/desktop/src/main/capabilities.ts`: catalog, install-state reducer, runtime resolver, runtime config patching, store access, and Superpowers resource resolution.
- Create `packages/desktop/src/main/capabilities.test.ts`: unit tests for catalog defaults, install state transitions, runtime manifest, and config patching.
- Create `packages/desktop/resources/capabilities/superpowers/skills/**`: bundled Superpowers by Obra skill files copied from the installed Superpowers plugin cache.
- Modify `packages/desktop/src/main/index.ts`: call `ensureCapabilityRuntime()` before spawning the sidecar and register capability IPC dependencies.
- Modify `packages/desktop/src/main/ipc.ts`: add capability IPC handlers.
- Modify `packages/desktop/src/preload/types.ts` and `packages/desktop/src/preload/index.ts`: expose capability APIs to the renderer.
- Modify `packages/app/src/context/platform.tsx`: add platform capability types and methods.
- Create `packages/app/src/context/capabilities.tsx`: renderer resource/mutation wrapper for capability snapshot, install, enable, disable, uninstall, and runtime patch application.
- Create `packages/app/src/components/settings-marketplace.tsx`: Settings > Marketplace UI.
- Modify `packages/app/src/components/dialog-settings.tsx`: add Marketplace tab.
- Modify `packages/app/src/components/status-popover-body.tsx`: add capability summary and Manage links.
- Modify `packages/app/src/i18n/en.ts`: add product-copy-reviewed Marketplace strings.
- Add focused tests in `packages/app/src/context/capabilities.test.ts` or `packages/app/src/components/settings-marketplace.test.tsx` for pure state/UI helpers.

## Task 1: Main-Process Capability Layer

**Files:**
- Create: `packages/desktop/src/main/capabilities.ts`
- Create: `packages/desktop/src/main/capabilities.test.ts`

- [ ] **Step 1: Write tests for defaults, transitions, and runtime resolution**

```ts
import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_CATALOG,
  createDefaultCapabilityState,
  installCapability,
  setCapabilityEnabled,
  uninstallCapability,
  resolveCapabilityRuntime,
} from "./capabilities"

describe("BharatCode capability layer", () => {
  test("bundles Superpowers enabled by default", () => {
    const state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })
    expect(state.installed["superpowers-obra"]?.status).toBe("enabled")
    expect(state.installed["superpowers-obra"]?.trust).toBe("bundled")
  })

  test("does not ship redundant filesystem shell or local git capabilities", () => {
    const ids = CAPABILITY_CATALOG.map((item) => item.id)
    expect(ids).not.toContain("filesystem")
    expect(ids).not.toContain("shell")
    expect(ids).not.toContain("local-git")
  })

  test("installs and enables a curated capability transactionally", () => {
    let state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })
    state = installCapability(state, "github", { now: "2026-05-31T01:00:00.000Z" })
    expect(state.installed.github?.status).toBe("installed")
    state = setCapabilityEnabled(state, "github", true, { now: "2026-05-31T01:01:00.000Z" })
    expect(state.installed.github?.status).toBe("needs_setup")
  })

  test("resolves enabled modules into a runtime manifest", () => {
    const state = createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" })
    const runtime = resolveCapabilityRuntime(state, { superpowersSkillsPath: "/tmp/superpowers/skills" })
    expect(runtime.skills.paths).toContain("/tmp/superpowers/skills")
    expect(runtime.mcp).toEqual({})
  })

  test("disabled Superpowers is removed from runtime", () => {
    const state = setCapabilityEnabled(
      createDefaultCapabilityState({ now: "2026-05-31T00:00:00.000Z" }),
      "superpowers-obra",
      false,
      { now: "2026-05-31T00:05:00.000Z" },
    )
    const runtime = resolveCapabilityRuntime(state, { superpowersSkillsPath: "/tmp/superpowers/skills" })
    expect(runtime.skills.paths).not.toContain("/tmp/superpowers/skills")
  })
})
```

- [ ] **Step 2: Run the failing test**

Run: `bun test src/main/capabilities.test.ts` from `packages/desktop`.

Expected: FAIL because `./capabilities` does not exist.

- [ ] **Step 3: Implement the domain model and pure reducers**

Create `packages/desktop/src/main/capabilities.ts` with exported catalog entries for `superpowers-obra`, `github`, `playwright`, `figma`, `linear`, `sentry`, `supabase`, `stripe`, and `cloudflare-docs`. Include these exported functions:

```ts
export function createDefaultCapabilityState(options?: { now?: string }): CapabilityState
export function installCapability(state: CapabilityState, id: string, options?: { now?: string }): CapabilityState
export function setCapabilityEnabled(
  state: CapabilityState,
  id: string,
  enabled: boolean,
  options?: { now?: string },
): CapabilityState
export function uninstallCapability(state: CapabilityState, id: string): CapabilityState
export function resolveCapabilityRuntime(
  state: CapabilityState,
  paths: { superpowersSkillsPath: string },
): CapabilityRuntimeManifest
```

Use a `CapabilityStatus` union of `available | installed | enabled | needs_setup | unhealthy | update_available`. Remote OAuth MCPs should resolve to `needs_setup` when enabled but not configured. Superpowers should resolve to `enabled` by default.

- [ ] **Step 4: Run the test to verify the pure layer passes**

Run: `bun test src/main/capabilities.test.ts` from `packages/desktop`.

Expected: PASS.

## Task 2: Bundled Superpowers And Engine Adapter

**Files:**
- Modify: `packages/desktop/src/main/capabilities.ts`
- Modify: `packages/desktop/src/main/capabilities.test.ts`
- Create: `packages/desktop/resources/capabilities/superpowers/skills/**`

- [ ] **Step 1: Copy bundled Superpowers skills**

Copy the installed Superpowers skill tree from:

```bash
/mnt/c/Users/Shrey\ Gupta/.codex/plugins/cache/openai-curated/superpowers/fef63ecf/skills
```

to:

```bash
packages/desktop/resources/capabilities/superpowers/skills
```

The copied tree must include every `SKILL.md` file and companion files used by those skills.

- [ ] **Step 2: Add adapter tests for hidden runtime config patching**

Extend `packages/desktop/src/main/capabilities.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyCapabilityRuntimeToConfig } from "./capabilities"

test("patches runtime config without exposing marketplace internals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bharatcode-capabilities-"))
  const configPath = join(dir, "opencode.jsonc")
  try {
    await writeFile(configPath, JSON.stringify({ plugin: ["bharatcode"] }, null, 2))
    await applyCapabilityRuntimeToConfig({
      configPath,
      runtime: {
        skills: { paths: ["/tmp/superpowers/skills"] },
        mcp: {
          github: {
            type: "remote",
            url: "https://api.githubcopilot.com/mcp/",
            enabled: false,
          },
        },
      },
    })
    const config = await readFile(configPath, "utf8")
    expect(config).toContain("\"skills\"")
    expect(config).toContain("\"/tmp/superpowers/skills\"")
    expect(config).toContain("\"github\"")
    expect(config).not.toContain("Capability Marketplace")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Implement config patching and resource resolution**

Add to `capabilities.ts`:

```ts
export function resolveBundledSuperpowersSkillsPath(resourcesPath: string): string
export async function applyCapabilityRuntimeToConfig(input: {
  configPath: string
  runtime: CapabilityRuntimeManifest
}): Promise<{ changed: boolean }>
export async function ensureCapabilityRuntime(options?: {
  home?: string
  resourcesPath?: string
  getStore?: CapabilityStoreFactory
}): Promise<CapabilitySnapshot>
```

Patch only `skills.paths` and `mcp` entries owned by enabled BharatCode capabilities. Preserve unrelated user config. Do not write visible OpenCode marketplace copy.

- [ ] **Step 4: Run adapter tests**

Run: `bun test src/main/capabilities.test.ts` from `packages/desktop`.

Expected: PASS.

## Task 3: Desktop Startup And IPC Bridge

**Files:**
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/preload/index.ts`

- [ ] **Step 1: Add IPC contract tests or type assertions**

Add compile-time exports in `preload/types.ts` for:

```ts
getCapabilitySnapshot: () => Promise<CapabilitySnapshot>
installCapability: (id: string) => Promise<CapabilitySnapshot>
setCapabilityEnabled: (id: string, enabled: boolean) => Promise<CapabilitySnapshot>
uninstallCapability: (id: string) => Promise<CapabilitySnapshot>
applyCapabilityRuntime: () => Promise<CapabilitySnapshot>
```

- [ ] **Step 2: Wire main dependencies**

Import `ensureCapabilityRuntime`, `getCapabilitySnapshot`, `installStoredCapability`, `setStoredCapabilityEnabled`, and `uninstallStoredCapability` in `index.ts`. Call `ensureCapabilityRuntime()` after `app.whenReady()` and before `spawnLocalServer(...)`.

- [ ] **Step 3: Register IPC handlers**

Extend `Deps` in `ipc.ts` and register:

```ts
ipcMain.handle("capabilities:get-snapshot", () => deps.getCapabilitySnapshot())
ipcMain.handle("capabilities:install", (_event, id: string) => deps.installCapability(id))
ipcMain.handle("capabilities:set-enabled", (_event, id: string, enabled: boolean) =>
  deps.setCapabilityEnabled(id, enabled),
)
ipcMain.handle("capabilities:uninstall", (_event, id: string) => deps.uninstallCapability(id))
ipcMain.handle("capabilities:apply-runtime", () => deps.applyCapabilityRuntime())
```

- [ ] **Step 4: Expose preload methods**

Add matching `window.api` methods in `preload/index.ts` and `preload/types.ts`.

- [ ] **Step 5: Run desktop main tests and typecheck**

Run from `packages/desktop`:

```bash
bun test src/main/capabilities.test.ts src/main/bharatcode-auth.test.ts
bun run typecheck
```

Expected: PASS.

## Task 4: Renderer Capability Context

**Files:**
- Modify: `packages/app/src/context/platform.tsx`
- Create: `packages/app/src/context/capabilities.tsx`
- Create: `packages/app/src/context/capabilities.test.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`

- [ ] **Step 1: Add renderer-side tests for runtime patch merging**

Create tests that call a pure helper:

```ts
import { describe, expect, test } from "bun:test"
import { mergeCapabilityRuntimeConfig } from "./capabilities"

describe("capability runtime config merge", () => {
  test("preserves user MCPs while applying BharatCode capabilities", () => {
    const next = mergeCapabilityRuntimeConfig(
      { mcp: { custom: { type: "local", command: ["custom-mcp"] } } },
      { mcp: { github: { type: "remote", url: "https://api.githubcopilot.com/mcp/", enabled: false } } },
    )
    expect(next.mcp?.custom).toEqual({ type: "local", command: ["custom-mcp"] })
    expect(next.mcp?.github).toEqual({ type: "remote", url: "https://api.githubcopilot.com/mcp/", enabled: false })
  })
})
```

- [ ] **Step 2: Add platform types**

In `platform.tsx`, define `CapabilitySnapshot`, `CapabilityCatalogItem`, `CapabilityInstallRecord`, and add optional platform methods matching preload.

- [ ] **Step 3: Implement `CapabilitiesProvider`**

Create a Solid context that loads `platform.getCapabilitySnapshot`, exposes `install`, `setEnabled`, `uninstall`, and calls `globalSync.updateConfig(mergeCapabilityRuntimeConfig(...))` after mutations so the running sidecar receives new MCP/skill config without asking the user to edit config files.

- [ ] **Step 4: Wrap the app**

In `packages/desktop/src/renderer/index.tsx`, expose platform methods by delegating to `window.api.*` and wrap `AppInterface` with `CapabilitiesProvider`.

- [ ] **Step 5: Run app tests and typecheck**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/context/capabilities.test.ts
bun run typecheck
```

Expected: PASS.

## Task 5: Settings > Marketplace UI

**Files:**
- Create: `packages/app/src/components/settings-marketplace.tsx`
- Modify: `packages/app/src/components/dialog-settings.tsx`
- Modify: `packages/app/src/i18n/en.ts`

- [ ] **Step 1: Build the Settings tab**

Add a Marketplace tab under the Desktop settings section:

```tsx
<Tabs.Trigger value="marketplace">
  <Icon name="plug" />
  {language.t("settings.marketplace.title")}
</Tabs.Trigger>
```

Add content:

```tsx
<Tabs.Content value="marketplace" class="no-scrollbar">
  <SettingsMarketplace />
</Tabs.Content>
```

- [ ] **Step 2: Implement Marketplace views**

`SettingsMarketplace` should render:

- Browse and Installed segmented filters.
- Search input.
- Dense capability rows with name, publisher, category, status, health, and primary action.
- Detail panel for selected capability with modules, permissions, requirements, and actions.
- Superpowers by Obra already visible as enabled.
- Curated capabilities for GitHub, Playwright, Figma, Linear, Sentry, Supabase, Stripe, and Cloudflare Docs.

- [ ] **Step 3: Add copy-reviewed strings**

Add direct strings such as:

```ts
"settings.marketplace.title": "Marketplace",
"settings.marketplace.search": "Search capabilities",
"settings.marketplace.superpowers.description": "Use Obra's development workflow skills inside BharatCode.",
"settings.marketplace.github.permission": "Can inspect GitHub pull requests, issues, Actions, releases, and repository metadata after you connect your account.",
"settings.marketplace.playwright.permission": "Can drive a browser for screenshots and UI smoke tests.",
"settings.marketplace.action.install": "Install",
"settings.marketplace.action.enable": "Enable",
"settings.marketplace.action.disable": "Disable",
"settings.marketplace.action.uninstall": "Uninstall",
"settings.marketplace.action.configure": "Configure",
```

Do not add user-facing OpenCode labels.

- [ ] **Step 4: Run renderer checks**

Run from `packages/app`:

```bash
bun run typecheck
```

Expected: PASS.

## Task 6: Status Surface And Operational Links

**Files:**
- Modify: `packages/app/src/components/status-popover-body.tsx`
- Modify: `packages/app/src/i18n/en.ts`

- [ ] **Step 1: Add capability summary**

Use `useCapabilities()` to compute installed count, enabled count, and unhealthy count. Add a Marketplace tab or footer summary with a Manage button that opens settings to the Marketplace tab if the existing dialog API supports it; otherwise open Settings and leave Marketplace visible as a tab.

- [ ] **Step 2: Keep MCP toggles intact**

Do not remove the existing MCP tab. Add copy that points users to Marketplace for installation/configuration while preserving existing connect/disconnect/auth actions.

- [ ] **Step 3: Run renderer checks**

Run from `packages/app`:

```bash
bun run typecheck
```

Expected: PASS.

## Task 7: Full Verification And Local Smoke Test

**Files:**
- No new source files unless verification finds defects.

- [ ] **Step 1: Run focused tests**

```bash
bun test src/main/capabilities.test.ts src/main/bharatcode-auth.test.ts
```

from `packages/desktop`, and:

```bash
bun test --preload ./happydom.ts ./src/context/capabilities.test.ts
```

from `packages/app`.

- [ ] **Step 2: Run typecheck and lint**

```bash
bun run typecheck
```

from `packages/desktop`, then:

```bash
bun run typecheck
```

from `packages/app`, then:

```bash
bun run lint
```

from the nested desktop repo root.

- [ ] **Step 3: Build desktop**

```bash
bun run build
```

from `packages/desktop`.

- [ ] **Step 4: Start desktop app for user testing**

```bash
bun run dev:desktop
```

from the nested desktop repo root.

Expected: Electron starts, Settings > Marketplace is visible, Superpowers by Obra is enabled, curated capabilities are listed, install/enable/disable updates state, and no visible Marketplace UI mentions OpenCode.

- [ ] **Step 5: Do not push**

Leave the branch local for user testing. Do not push until the user approves after local testing.
