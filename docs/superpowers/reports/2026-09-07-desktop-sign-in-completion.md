# Desktop sign-in completion correction

## Scope and baseline

- Base: released Desktop 1.15.28, `55cce6826b0d44dd790c429fc57337a506e862b9`.
- Branch: `codex/account-switch-completion`, isolated worktree `apps/desktop/.worktrees/account-switch-completion`.
- Installed version/source were checked read-only; installed app.asar SHA-256 was `cd1b75da346089d0f9b51b51cbb5dcad6412e14e69424ce91f942cf059b4cd1f`.
- No backend entitlement, OAuth issuer, credential-store format/ACL, shared Auth transaction, release workflow, or package version changes.

## Confirmed defect

Main returned `authorizing` after opening the browser, but completion polling read ordinary account status. The runtime correctly returned `signed-out` while the callback was pending. Settings and titlebar stopped polling at that first response; Settings also emitted an unconditional success toast. Callback completion did not notify the independently cached renderer resources.

The extracted released Settings sign-in function was exercised without network or credentials: first attempt performed one poll; after synthetic callback completion the backend was signed in but the view remained signed out, with a success toast. A second attempt refreshed the view to signed in. This reproduces the client defect; it does not establish the identity of the unrelated student request or explain its denial.

## Correction

- A main-only coordinator owns one current OAuth attempt. Browser-open is not success. `beginSignIn` resolves only after the exact matching callback commits and returns confirmed signed-in status.
- Status remains authorizing/switching while pending, including when the store is still signed out or still contains the previous account.
- Callback state matching and one-time admission reject stale, duplicate, malformed and superseded callbacks before exchange. State/code/URLs never enter renderer events.
- Callback mutation, logout and new authorization preparation are serialized through the existing account transport. Logout during exchange cancels the UI waiter immediately and removes the resulting credentials after exchange. Other cancellation during exchange clears its late result inside the same queue before newer authorization proceeds.
- A 180-second browser-wait deadline rejects safely and closes callback admission. Once exchange is admitted, its transaction is allowed to finish in queue rather than abandoned mid-write; existing runtime token-request timeout remains unchanged. This change does not introduce a new general transport timeout policy.
- Window closure cancels pending UI work; sidecar disposal settles the waiter and clears its timer. Callback/launch errors expose fixed messages, not raw transport errors.
- Safe account status events carry monotonically increasing main revisions. Settings, both titlebars, status popover and initial AuthGate subscribe through the same resource helper. Older reads or IPC replies cannot overwrite a newer callback/logout event. Unmount removes subscriptions; late subscribers read current status.
- Existing UI layout is preserved. The auth gate reflects pending state, and success toasts no longer follow browser-open.

## Verification

- RED: new coordinator and account-state tests initially failed on absent modules. The released-function synthetic reproduction above separately establishes behavioral RED.
- Focused coordinator: 10 passed / 0 failed, 34 assertions; covers delayed callback, old-account switch, superseded/duplicate callbacks, exchange/logout ordering, stale successful/failed status reads, timeout, disposal, window cancellation during exchange, safe callback failure and late subscription.
- Resource coverage: three revision-order tests plus a subprocess using Solid's browser implementation. Two mounted resources receive the same callback event, ignore earlier initial reads, and remove listeners on disposal.
- Full Desktop: 242 passed / 0 failed, 1,414 assertions, 36 files.
- Full App: 400 passed / 0 failed, 1,042 assertions, 71 files.
- Desktop and App `bun typecheck`: passed.
- App production build: passed; existing large-chunk warning remains.
- Existing browser-handoff and startup-order source assertions were updated for the coordinator composition, preserving the host-browser boundary and recovery-before-account invariant.
- UI mechanical detector: no findings on changed account settings/titlebar/AuthGate targets.
- Dependencies were installed with the frozen lockfile and scripts disabled. The exact pinned Linux native TypeScript compiler needed a local optional-package resolution link; no manifest or lockfile changed.

## Remaining release work

### CTO review follow-up: overlapping logout barrier

CTO reproduced a P2 on initial correction `d4f7cbad435829831a497afb75e3793959afce0e`: the first of two overlapping logout calls could release a shared boolean read barrier while the second was still pending. If the first failed, a read of old credentials could then overwrite the later successful logout status.

The additive correction gives every queued logout its own counted barrier and invalidates outstanding read sequence numbers at every logout settlement. The exact regression failed before the correction (`readsWhileRemoving`: expected 0, received 1), then passed with no old signed-in read/publication. Focused account/session, account transport, deep-link privacy and sidecar-boundary matrix: 26 passed / 0 failed, 105 assertions. Desktop typecheck and changed-file formatting/whitespace passed. App source and package artifacts were unchanged by this follow-up; no additional hosted CI, build or release was launched.

This is local source verification, not installed OAuth acceptance. Read-only GitHub inspection still lists `desktop-beta-1.15.28` as the most recent published prerelease; no stable/latest release exists through GitHub's latest endpoint.

CTO independent exact-commit review is required. A separately prepared version-bumped package must carry this source, followed by authorized normal installed sign-out/sign-in with a different account, delayed browser completion, and confirmation that Account/model views update on the first attempt. No current profile, credentials, browser state, app process, package installation, production system or publication was mutated for this work.

Student trial/eligibility remains an independent backend finding; this client correction must not be represented as proof of that incident's request identity.
