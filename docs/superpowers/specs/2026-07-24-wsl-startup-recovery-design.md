# WSL Startup Recovery Design

## Context

The published unsigned Windows beta can stop before creating its first application window when WSL is already enabled
and the selected distribution later fails validation or runtime startup. Retry and disable controls currently live in the
renderer, so they are unreachable in this failure path.

## Goal

Give the user one small, explicit, native recovery path when enabled WSL startup fails before the main window exists.
The user can retry WSL, disable WSL and restart BharatCode, or quit.

## Non-goals

- Do not change the normal local-runtime or successful WSL startup paths.
- Do not silently fall back to the Windows runtime.
- Do not select, install, repair, or mutate a WSL distribution.
- Do not add telemetry, dependencies, signing, ShareNext, or broader beta functionality.
- Do not expose distribution names, filesystem paths, process output, credentials, OAuth data, or exception text.

## Design

Add a focused main-process startup-recovery coordinator with injected operations so its state transitions can be tested
without Electron or WSL. The coordinator first attempts the existing `wslLifecycle.start()` operation. A successful
start returns immediately and preserves the current startup flow.

If startup fails, the coordinator classifies the failure into the existing renderer-safe `WslErrorCode` contract and
asks an injected native prompt for one of three actions:

1. `retry`: run the same lifecycle start operation again, including its existing revalidation.
2. `disable-and-restart`: read the current WSL revision, persist `{ enabled: false, expectedRevision }` through the
   existing WSL service, and use the existing controlled relaunch path.
3. `quit`: close BharatCode without creating the main window or starting the local sidecar.

The native Electron adapter uses a modal message box owned by no renderer window because the renderer does not yet
exist. The buttons are exactly `Retry WSL`, `Disable WSL and restart`, and `Quit`. Its message identifies only the safe
failure category and states that BharatCode did not switch runtimes automatically.

The coordinator returns only after WSL starts. Disable-and-restart and quit are terminal callbacks: they initiate the
chosen process transition and prevent the current startup attempt from continuing to sidecar readiness or window
creation.

## Error handling

- A retry failure reopens the same prompt with the newly classified safe error code.
- If saving the disabled state fails, the prompt remains available with a generic `configuration-failed` category. The
  user can retry the disable operation, retry WSL startup, or quit.
- A revision conflict is never overwritten; it follows the same generic configuration-failure path.
- The new recovery coordinator and prompt adapter log only the safe category. Existing lower-level lifecycle logging is
  unchanged.
- No recovery action may authorize the Windows sidecar while WSL remains enabled.

## File boundaries

- `packages/desktop/src/main/wsl-startup-recovery.ts`: pure recovery action types and orchestration.
- `packages/desktop/src/main/wsl-startup-recovery.test.ts`: behavioral tests for success, repeated retry, disable,
  persistence failure, quit, and safe error projection.
- `packages/desktop/src/main/windows.ts`: the native message-box adapter and exact user-facing copy.
- `packages/desktop/src/main/index.ts`: inject existing WSL start, configuration, relaunch, quit, logging, and prompt
  operations at the enabled-WSL startup boundary.

No renderer, preload, IPC, WSL runtime, workflow, packaging, or release file changes are required.

## Acceptance criteria

- Successful WSL startup behaves exactly as it does now and shows no dialog.
- A pre-window WSL startup failure always offers all three approved actions.
- Retry revalidates and attempts WSL startup again without creating a local sidecar.
- Disable persists the exact next revision before one controlled relaunch.
- Quit and disable never fall through to sidecar startup or main-window creation.
- Dialog inputs and logs added by this change never contain raw exception messages or private runtime data.
- Focused recovery, WSL lifecycle, WSL acceptance, sign-in, and sidecar authorization tests pass.
- Desktop typecheck, formatting, and `git diff --check` pass.
- A replacement installer is not published until a Windows agent proves the additive source in a native packaged run.
