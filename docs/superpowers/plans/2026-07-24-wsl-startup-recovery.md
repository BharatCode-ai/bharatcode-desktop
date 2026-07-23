# WSL Startup Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved native Retry, Disable-and-restart, or Quit path when enabled WSL startup fails before the first BharatCode window exists.

**Architecture:** A pure main-process coordinator owns the recovery loop and receives all side effects as injected operations. `windows.ts` adapts its safe code and three actions to an Electron message box, while `index.ts` wires the coordinator only into the existing enabled-WSL startup branch.

**Tech Stack:** TypeScript, Bun test, Electron 41 message-box API, Effect-based Desktop startup, existing WSL lifecycle/service contracts.

## Global Constraints

- Do not change the normal local-runtime or successful WSL startup paths.
- Do not silently fall back to the Windows runtime.
- Do not select, install, repair, or mutate a WSL distribution.
- Do not add telemetry, dependencies, signing, ShareNext, or broader beta functionality.
- Do not expose distribution names, filesystem paths, process output, credentials, OAuth data, or exception text.
- The buttons are exactly `Retry WSL`, `Disable WSL and restart`, and `Quit`.
- A replacement installer is not published until a Windows agent proves the additive source in a native packaged run.

---

### Task 1: Pure WSL startup recovery coordinator

**Files:**

- Create: `packages/desktop/src/main/wsl-startup-recovery.ts`
- Create: `packages/desktop/src/main/wsl-startup-recovery.test.ts`

**Interfaces:**

- Consumes: `WslErrorCode` and `WslLifecycleFailure`.
- Produces:
  - `WslStartupRecoveryCode = WslErrorCode | "configuration-failed"`
  - `WslStartupRecoveryAction = "retry" | "disable-and-restart" | "quit"`
  - `projectWslStartupRecoveryCode(error: unknown): WslErrorCode`
  - `recoverWslStartup(options): Promise<void>`
- `disableAndRestart` and `quit` are terminal `() => Promise<never>` operations. Only successful WSL startup resolves the coordinator.

- [ ] **Step 1: Write the failing behavioral tests**

Create `packages/desktop/src/main/wsl-startup-recovery.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { WslLifecycleFailure } from "./wsl-lifecycle"
import { projectWslStartupRecoveryCode, recoverWslStartup, type WslStartupRecoveryAction } from "./wsl-startup-recovery"

function terminal(label: string, effects: string[]): Promise<never> {
  effects.push(label)
  return Promise.reject(new Error(`terminal:${label}`))
}

describe("pre-window WSL startup recovery", () => {
  test("successful WSL startup resolves without prompting", async () => {
    const effects: string[] = []
    await recoverWslStartup({
      start: async () => {
        effects.push("start")
      },
      prompt: async () => {
        effects.push("prompt")
        return "quit"
      },
      disableAndRestart: () => terminal("disable", effects),
      quit: () => terminal("quit", effects),
    })
    expect(effects).toEqual(["start"])
  })

  test("retry revalidates through the injected start operation until it succeeds", async () => {
    const effects: string[] = []
    let starts = 0
    await recoverWslStartup({
      start: async () => {
        starts += 1
        effects.push(`start:${starts}`)
        if (starts === 1) throw new WslLifecycleFailure("prerequisite-missing")
      },
      prompt: async (code) => {
        effects.push(`prompt:${code}`)
        return "retry"
      },
      disableAndRestart: () => terminal("disable", effects),
      quit: () => terminal("quit", effects),
    })
    expect(effects).toEqual(["start:1", "prompt:prerequisite-missing", "start:2"])
  })

  test("a failed retry presents the newly classified safe code", async () => {
    const effects: string[] = []
    const actions: WslStartupRecoveryAction[] = ["retry", "quit"]
    let starts = 0
    await expect(
      recoverWslStartup({
        start: async () => {
          starts += 1
          effects.push(`start:${starts}`)
          throw starts === 1 ? new WslLifecycleFailure("connection-lost") : new WslLifecycleFailure("runtime-integrity")
        },
        prompt: async (code) => {
          effects.push(`prompt:${code}`)
          return actions.shift() ?? "quit"
        },
        disableAndRestart: () => terminal("disable", effects),
        quit: () => terminal("quit", effects),
      }),
    ).rejects.toThrow("terminal:quit")
    expect(effects).toEqual(["start:1", "prompt:connection-lost", "start:2", "prompt:runtime-integrity", "quit"])
  })

  test("disable is terminal and a persistence failure keeps recovery available", async () => {
    const effects: string[] = []
    const actions: WslStartupRecoveryAction[] = ["disable-and-restart", "disable-and-restart"]
    let disables = 0
    await expect(
      recoverWslStartup({
        start: async () => {
          effects.push("start")
          throw new WslLifecycleFailure("selection-invalid")
        },
        prompt: async (code) => {
          effects.push(`prompt:${code}`)
          return actions.shift() ?? "quit"
        },
        disableAndRestart: async () => {
          disables += 1
          effects.push(`disable:${disables}`)
          if (disables === 1) throw new Error("private persistence detail")
          return terminal("relaunch", effects)
        },
        quit: () => terminal("quit", effects),
      }),
    ).rejects.toThrow("terminal:relaunch")
    expect(effects).toEqual([
      "start",
      "prompt:selection-invalid",
      "disable:1",
      "prompt:configuration-failed",
      "disable:2",
      "relaunch",
    ])
  })

  test("unknown startup errors project only to start-failed", () => {
    expect(projectWslStartupRecoveryCode(new Error("C:\\private\\repo secret@example.com"))).toBe("start-failed")
    expect(projectWslStartupRecoveryCode(new WslLifecycleFailure("root-user"))).toBe("root-user")
  })
})
```

- [ ] **Step 2: Run the new suite and verify RED**

Run:

```bash
cd packages/desktop
bun test src/main/wsl-startup-recovery.test.ts
```

Expected: FAIL because `./wsl-startup-recovery` does not exist.

- [ ] **Step 3: Implement the minimal pure coordinator**

Create `packages/desktop/src/main/wsl-startup-recovery.ts`:

```ts
import type { WslErrorCode } from "./wsl-contract"
import { WslLifecycleFailure } from "./wsl-lifecycle"

export type WslStartupRecoveryCode = WslErrorCode | "configuration-failed"
export type WslStartupRecoveryAction = "retry" | "disable-and-restart" | "quit"

export function projectWslStartupRecoveryCode(error: unknown): WslErrorCode {
  return error instanceof WslLifecycleFailure ? error.code : "start-failed"
}

export async function recoverWslStartup(options: {
  start: () => Promise<void>
  prompt: (code: WslStartupRecoveryCode) => Promise<WslStartupRecoveryAction>
  disableAndRestart: () => Promise<never>
  quit: () => Promise<never>
}): Promise<void> {
  let code: WslStartupRecoveryCode
  try {
    await options.start()
    return
  } catch (error) {
    code = projectWslStartupRecoveryCode(error)
  }

  while (true) {
    const action = await options.prompt(code)
    if (action === "retry") {
      try {
        await options.start()
        return
      } catch (error) {
        code = projectWslStartupRecoveryCode(error)
      }
      continue
    }
    if (action === "disable-and-restart") {
      try {
        return await options.disableAndRestart()
      } catch {
        code = "configuration-failed"
      }
      continue
    }
    return options.quit()
  }
}
```

- [ ] **Step 4: Run coordinator and existing lifecycle tests**

Run:

```bash
cd packages/desktop
bun test src/main/wsl-startup-recovery.test.ts src/main/wsl-lifecycle.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Commit the pure coordinator**

```bash
git add packages/desktop/src/main/wsl-startup-recovery.ts packages/desktop/src/main/wsl-startup-recovery.test.ts
git commit -m "fix(desktop): coordinate WSL startup recovery"
```

### Task 2: Native dialog and enabled-WSL startup wiring

**Files:**

- Modify: `packages/desktop/src/main/windows.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/wsl-startup-recovery.test.ts`

**Interfaces:**

- Consumes: `WslStartupRecoveryCode`, `WslStartupRecoveryAction`, `recoverWslStartup`, `wslService.snapshot`,
  `wslService.configure`, and the existing `relaunchDesktop`.
- Produces:
  - `showWslStartupRecoveryDialog(code: WslStartupRecoveryCode): Promise<WslStartupRecoveryAction>`
  - `quitBeforeStartup(): Promise<never>` in `index.ts`
  - Enabled-WSL startup recovery before any local sidecar, server-ready signal, or main-window creation.

- [ ] **Step 1: Add failing source-boundary tests**

Append these tests inside the existing `describe` block in
`packages/desktop/src/main/wsl-startup-recovery.test.ts`:

```ts
test("native prompt has only the approved safe actions and copy", async () => {
  const source = await Bun.file(new URL("./windows.ts", import.meta.url)).text()
  const start = source.indexOf("export async function showWslStartupRecoveryDialog")
  const end = source.indexOf("\n}\n", start)
  const prompt = source.slice(start, end + 2)

  expect(start).toBeGreaterThan(-1)
  expect(prompt).toContain('["Retry WSL", "Disable WSL and restart", "Quit"]')
  expect(prompt).toContain('message: "BharatCode could not start its WSL runtime."')
  expect(prompt).toContain("BharatCode did not switch to the Windows runtime automatically.")
  expect(prompt).toContain("Failure category: ${code}")
  expect(prompt).toContain("defaultId: 0")
  expect(prompt).toContain("cancelId: 2")
  expect(prompt).not.toMatch(/error\\.message|selectedDisplayName|distribution|stdout|stderr|path|email/iu)
})

test("enabled startup recovers before sidecar readiness and never enters the local fallback branch", async () => {
  const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()
  const enabled = source.indexOf("if (wslSnapshot.enabled)")
  const recovery = source.indexOf("await recoverWslStartup(", enabled)
  const localAuthorization = source.indexOf("sidecarAuthorization = createSidecarAuthorizationPolicy", enabled)
  const serverReady = source.indexOf("yield* Deferred.succeed(serverReady", enabled)
  const windowCreation = source.indexOf("mainWindow = createMainWindow", enabled)

  expect(enabled).toBeGreaterThan(-1)
  expect(recovery).toBeGreaterThan(enabled)
  expect(source.slice(recovery, localAuthorization)).toContain("start: () => wslLifecycle!.start()")
  expect(source.slice(recovery, localAuthorization)).toContain("prompt: showWslStartupRecoveryDialog")
  expect(source.slice(recovery, localAuthorization)).toContain("enabled: false")
  expect(source.slice(recovery, localAuthorization)).toContain("expectedRevision: current.revision")
  expect(source.slice(recovery, localAuthorization)).toContain("return relaunchDesktop()")
  expect(source.slice(recovery, localAuthorization)).toContain("quit: quitBeforeStartup")
  expect(localAuthorization).toBeGreaterThan(recovery)
  expect(serverReady).toBeGreaterThan(localAuthorization)
  expect(windowCreation).toBeGreaterThan(serverReady)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/desktop
bun test src/main/wsl-startup-recovery.test.ts
```

Expected: the pure coordinator tests pass, while both new production-composition tests fail because the prompt and wiring
do not exist.

- [ ] **Step 3: Add the native prompt adapter**

In `packages/desktop/src/main/windows.ts`, import the recovery types:

```ts
import type { WslStartupRecoveryAction, WslStartupRecoveryCode } from "./wsl-startup-recovery"
```

Add this exported adapter before `createMainWindow`:

```ts
export async function showWslStartupRecoveryDialog(code: WslStartupRecoveryCode): Promise<WslStartupRecoveryAction> {
  const buttons = ["Retry WSL", "Disable WSL and restart", "Quit"]
  const result = await dialog.showMessageBox({
    type: "error",
    title: "BharatCode WSL startup",
    buttons,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: "BharatCode could not start its WSL runtime.",
    detail: `Failure category: ${code}\n\nBharatCode did not switch to the Windows runtime automatically.`,
  })
  if (result.response === 0) return "retry"
  if (result.response === 1) return "disable-and-restart"
  return "quit"
}
```

- [ ] **Step 4: Wire only the enabled-WSL branch**

In `packages/desktop/src/main/index.ts`:

1. Import `showWslStartupRecoveryDialog` from `./windows`.
2. Import `recoverWslStartup` from `./wsl-startup-recovery`.
3. Make `relaunchDesktop` terminal and add the quit terminal:

```ts
function neverCompletes(): Promise<never> {
  return new Promise<never>(() => undefined)
}

async function relaunchDesktop(): Promise<never> {
  try {
    await killSidecar()
  } finally {
    app.relaunch()
    app.exit(0)
  }
  return neverCompletes()
}

function quitBeforeStartup(): Promise<never> {
  app.quit()
  return neverCompletes()
}
```

4. Replace only the enabled branch’s direct start:

```ts
if (wslSnapshot.enabled) {
  await recoverWslStartup({
    start: () => wslLifecycle!.start(),
    prompt: showWslStartupRecoveryDialog,
    disableAndRestart: async () => {
      const current = await wslService.snapshot()
      const disabled = await wslService.configure({
        enabled: false,
        expectedRevision: current.revision,
      })
      if (disabled.enabled || disabled.revision !== current.revision + 1) {
        throw new Error("WSL disable did not reach the exact next revision.")
      }
      return relaunchDesktop()
    },
    quit: quitBeforeStartup,
  })
  return {
    listener: { stop: () => wslLifecycle!.stop() },
    health: { wait: Promise.resolve() },
  }
}
```

Do not move or modify the local `createSidecarAuthorizationPolicy` branch.

- [ ] **Step 5: Run focused recovery, lifecycle, service, and authorization tests**

Run:

```bash
cd packages/desktop
bun test \
  src/main/wsl-startup-recovery.test.ts \
  src/main/wsl-lifecycle.test.ts \
  src/main/wsl-distro.test.ts \
  src/main/sidecar-auth.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 6: Run typecheck and formatting**

Run:

```bash
cd packages/desktop
bun run typecheck
bunx prettier --check \
  src/main/wsl-startup-recovery.ts \
  src/main/wsl-startup-recovery.test.ts \
  src/main/windows.ts \
  src/main/index.ts
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit native recovery wiring**

```bash
git add \
  packages/desktop/src/main/wsl-startup-recovery.test.ts \
  packages/desktop/src/main/windows.ts \
  packages/desktop/src/main/index.ts
git commit -m "fix(desktop): recover failed WSL startup"
```

### Task 3: Published-boundary verification and review

**Files:**

- Verify: all files changed from published source `0b39f65eaf71f3850bf08a30f07a05243a988173`
- Do not create or modify release, workflow, packaging, signing, or ShareNext files.

**Interfaces:**

- Consumes: Tasks 1–2 commits plus the earlier cold-start sign-in correction.
- Produces: a clean additive source SHA ready for one Windows-native packaged proof.

- [ ] **Step 1: Run the full focused beta-stabilization suite**

```bash
cd packages/desktop
bun test \
  src/main/wsl-startup-recovery.test.ts \
  src/main/wsl-lifecycle.test.ts \
  src/main/wsl-distro.test.ts \
  src/main/wsl-runtime.test.ts \
  src/main/wsl-acceptance.test.ts \
  src/main/startup-recovery.test.ts \
  src/main/bharatcode-auth.test.ts \
  src/main/sidecar-auth.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run build and repository hygiene gates**

```bash
cd packages/desktop
bun run typecheck
bunx prettier --check \
  src/main/wsl-startup-recovery.ts \
  src/main/wsl-startup-recovery.test.ts \
  src/main/windows.ts \
  src/main/index.ts \
  src/main/bharatcode-auth.test.ts
cd ../..
git diff --check 0b39f65eaf71f3850bf08a30f07a05243a988173..HEAD
git show --check --oneline HEAD
git status --short
```

Expected: typecheck, formatting, diff, and commit checks exit 0; `git status --short` is empty.

- [ ] **Step 3: Prove the additive published-source boundary**

```bash
git merge-base --is-ancestor 0b39f65eaf71f3850bf08a30f07a05243a988173 HEAD
git diff --name-only 0b39f65eaf71f3850bf08a30f07a05243a988173..HEAD
git diff --name-only 0b39f65eaf71f3850bf08a30f07a05243a988173..HEAD -- \
  .github \
  packages/desktop/electron-builder.config.ts \
  packages/desktop/scripts \
  packages/opencode \
  packages/desktop/src/renderer \
  packages/desktop/src/preload
```

Expected:

- The ancestry command exits 0.
- The full file list contains only the two sign-in correction files, the WSL design/plan documents, and the four WSL
  recovery implementation/test files.
- The prohibited-expansion command prints nothing.

- [ ] **Step 4: Request an independent code review**

Review these invariants against the actual diff:

1. Successful WSL and local-runtime startup behavior is unchanged.
2. Retry calls the existing lifecycle start operation.
3. Disable uses a fresh exact revision, persists before relaunch, and cannot overwrite a conflict.
4. Disable and quit cannot fall through to local sidecar startup or window creation.
5. The new prompt and new logs expose only a safe category.
6. No workflow, packaging, signing, ShareNext, renderer, preload, or unrelated feature expansion occurred.

Expected: no Critical or Important findings. Resolve any such finding test-first, then repeat Tasks 3.1–3.4.

- [ ] **Step 5: Capture the exact Windows handoff identity**

```bash
git rev-parse HEAD
git rev-parse HEAD^
git status --short
```

Expected: record the two exact SHAs produced by these commands; status is empty. Use those identities in one
consolidated Windows-agent prompt covering both cold-start sign-in and WSL startup recovery. Do not push, dispatch,
package, publish, sign, or activate ShareNext from this Linux/WSL session.
