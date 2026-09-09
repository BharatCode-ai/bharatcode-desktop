# General access-denial links: local client checkpoint

Base: released Desktop/CLI 1.15.27 source `c832c3810253bf91f1e3bebffce60fde6b00be8f`.
Branch: `codex/access-denial-links`. This is a client presentation change, not a new entitlement policy.

## Contract

The exact agreed plaintext message is:

```text
BharatCode App requires Pro or student access. Subscribe to Pro (https://bharatcode.ai/subscribe), or sign in with your student email. Need verification? Contact help@bharatcode.ai.

BharatCode Chat (https://chat.bharatcode.ai) is free for everyone.
```

Only this known message maps to two GUI paragraphs and three fixed links. GUI labels are Subscribe to Pro, help@bharatcode.ai, and BharatCode Chat. Current and legacy session error surfaces reuse the existing error Card and Desktop external-link bridge. No arbitrary URL extraction, HTML/Markdown interpretation, or unconditional browser launch is introduced.

TUI uses OpenTUI's native inline link node and preserves explicit URL/address text. Plain CLI errors use OSC 8 on TTY output unless TERM=dumb; explicit visible URLs remain readable even if a terminal does not support hyperlinks. Redirected output remains plaintext. Other/heavy-tier messages retain their text; existing error formatting is not replaced. HTTP status/type/code, entitlement checks, JSON event production, and the heavy-tier server message are unchanged.

## Verification

- RED: absent Core/CLI helper imports failed before implementation. Actual GUI SSR harness initially failed because Solid was compiled in client mode; setting its test-only SSR option corrected the harness. No production rendering fallback was added to satisfy it.
- Core full package: 375 passed, 0 failed, 718 assertions.
- UI full src suite: 26 passed, 0 failed, 65 assertions. Actual Solid SSR tests verify two paragraphs, three exact hrefs, safe external-link attributes, labels, and escaped unknown input.
- App full src suite: 396 passed, 0 failed, 1,035 assertions.
- OpenCode focused error/CLI/TUI: 14 passed, 0 failed, 49 assertions. Includes actual terminal rendering, a subprocess invoking the production CLI error writer in TTY/non-TTY/dumb modes, fixed OSC 8 destinations, visible URL fallback, and unchanged unrelated errors.
- Core, UI, App, and OpenCode package typechecks pass.
- Changed-file Prettier and Git whitespace checks pass; Impeccable detector reports no findings in the new GUI component.

The isolated worktree reuses installed dependency bytes through ignored links. Initial typechecks exposed missing local workspace links and an incorrect linked marked version; the worktree links were corrected to its own workspace packages and the declared installed marked 17.0.1. No dependency manifest/lockfile or other worktree was changed. This is not a pristine-install or full OpenCode-suite claim.

## Boundaries and remaining work

Local source verification only: no version bump, client producer, installer, installed UI exercise, publication, or deployment is claimed by this checkpoint. The installed/public 1.15.27 client still has plain error rendering. Exact-commit CTO review and a separately identified client release are pending. Infrastructure owns the independently compatible server plaintext change and its CI/rollout; no duplicate runner or server mutation is part of this client work.

Historical rehearsal 003, its receipts and outcomes, student provisioning, protected keys/timers, and completed 1.15.27 release evidence remain untouched. No new live entitlement rehearsal was run for this cosmetic change.
