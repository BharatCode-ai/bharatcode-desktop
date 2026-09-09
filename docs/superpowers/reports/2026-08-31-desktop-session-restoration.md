# Desktop last-conversation restoration

Scope: narrow correction on `codex/windows-recovery-actions`, parent
`c2d5a9ec1d0221f7a048a06006c9d2df6f27c6fc`. No tray behavior, database,
credential, migration, installer, publication, or live-profile change.

## Diagnosis and history

- Read-only native metadata showed a saved session and two messages surviving
  the reported process restart. No conversation contents were inspected.
- Upstream `6b8902e8b91a7561d57f80249feada949c4d0665` contains last-session
  project navigation. BharatCode `4b0544efefb4c087d861eee273a5d6e92919cce4`
  introduced the root redirect directly to an empty `/session` route, bypassing
  remembered-session selection. The new-design branch also disables the old
  layout autoselection.
- The inherited Electron main path has no tray construction or close-to-hide
  handler. The inspected pre-consolidation Tauri source only mentions a tray
  dependency in its lockfile, not a tray implementation. No universal claim
  about every historical upstream release is made.

## Correction

- Layout is the sole startup navigation owner. Desktop waits for persisted
  layout/page/server state and global synchronization in both design channels.
- The remembered session is fetched in its workspace and checked for matching
  identity, permitted directory, and non-archived state. Existing path-key and
  latest-root-session semantics are retained.
- If initial project metadata omits the remembered workspace, authoritative
  worktree membership is refreshed before disqualifying it. A refresh failure
  is not a missing workspace.
- Only definite absence/ineligibility falls back to the latest visible root
  session, or a new chat when there are genuinely no eligible conversations.
- Service errors retain the saved selection and expose a fixed, localized
  Retry message without forwarding raw error data. Requests have a bounded
  timeout. Retry does not submit while loading.
- Attempt generation, route/server changes, and disposal invalidate older
  work. Successful restoration replaces the startup history entry and cannot
  override an explicit session route or later navigation.
- Existing web project-selection behavior and window-close behavior remain.

## Verification

- RED: two existing startup-path calls returned empty-chat routes despite a
  saved conversation; both failed before the implementation.
- Focused: 24 tests covering saved sessions, worktrees, missing/archived
  sessions, first use, native Windows slash spellings, unrelated-project
  rejection, authoritative membership failures, retry, generation cancellation,
  and late resolution. A delayed old request resolves after a newer request;
  the old result is rejected. Source assertions additionally bind the Layout
  wiring; they are not a rendered-Electron test.
- Full App suite, Linux and native Windows: **394 passed, 0 failed, 1,032
  assertions**, 69 files, after the final test edits.
- App typecheck: Linux and native Windows PASS. Desktop native typecheck PASS.
- Native App production build PASS (19.87 seconds); existing large-chunk
  advisory remains. This is a frontend build, not an installer rebuild.
- Interface detector: no findings. Existing visual design unchanged; three
  new error/retry strings use the existing English fallback for other locales.
- Prior QA pending-source review found a missing authoritative-worktree refresh;
  it was corrected and covered. Independent final review remains requested.

## Remaining acceptance / boundaries

The installed diagnostic package remains source `d3dc1b13d36ac3b61dc3665d5c6eb2771b50b18c`.
No app restart, installation, user-profile mutation, database write, or credential
read occurred in this correction. A matching packaged synthetic close/reopen
test must still show the same conversation and messages before recommending a
replacement installer. Unit/source checks and a frontend build do not establish
installed UI acceptance. Formal JIT/WSL acceptance and release promotion remain
separately held.

The WSL root had only about 49 MiB free during this work. Build outputs were kept
on the Windows build volume; no disk expansion or unrelated cleanup was done.
