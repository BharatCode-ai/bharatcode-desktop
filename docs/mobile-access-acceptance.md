# Mobile access acceptance

The connector uses the existing native local Desktop sidecar and `https://tunnel.bharatcode.ai`. Mobile never starts another agent. WSL-selected runtimes are outside the current connection scope; do not infer Windows/WSL parity from Linux source checks.

## October 27 reliability fixes

Mobile-access controller construction no longer reads or writes storage. Guarded restoration and explicit actions load device state; invalid or inaccessible mobile state reports an error in Mobile devices settings without rejecting Desktop initialization. Failed reads never replace the registry. An explicit, confirmed revoke-all/reset preserves an invalid registry as a private `devices.json.corrupt-*` backup before creating clean state. Permission or other I/O failures do not trigger this recovery. Backups remain inside the Desktop private user-data directory and must not be attached to public issues.

Reset and Disable cancel in-progress provisioning before joining the action queue. They also invalidate queued Pair or Restore work; asynchronous storage reads cannot start another connection after cancellation. A failed enabled-preference write closes the newly created gateway/tunnel and leaves access disabled. The settings component permits Reset during provisioning, keeps other controls busy until outstanding actions settle, and ignores stale action/poll responses. Storage errors have their own localized message.

Directory listing enumerates a directory before opening regular-file handles, avoiding reliance on POSIX directory handles. File-handle type/size checks and resolved project confinement remain in place. Actual Windows/macOS acceptance remains a separate check.

## Reproducible source checks

Run from package directories:

```sh
# packages/mobile-connector
node --test

# packages/desktop
bun run test
bun run typecheck

# packages/app
bun run typecheck
bun run typecheck:e2e
bun run test:unit
bun run test:browser
bun x playwright test --config e2e/reproduction/mobile-settings/playwright.config.ts
```

The dedicated browser fixture renders the production Settings component, language provider and controls. It supplies deterministic responses only at the IPC boundary. It covers storage errors, provisioning/reset cancellation, matching-code approval, decline and confirmed individual revocation. Its screenshots demonstrate renderer behavior, not actual Electron IPC, certificate issuance or a phone connection. The cancellation test controls the browser clock so a later polling refresh cannot hide a stale cancelled-action error.

The pre-existing Arabic localization-parity failure at the reviewed base concerns four `ui.message.outputLimit*` keys. Record that failure if still present; do not suppress it or relabel the complete app suite green. Exact-source qualification, artifact identity and results must be recorded before claiming a build is ready for user acceptance.

## Final user acceptance

Record Desktop candidate hash/source commit, Mobile version/build, OS/device and approximate time with each result. Use a disposable phone identity and preserve existing paired devices. Run destructive reset/storage-recovery checks only in a disposable Desktop profile.

- [ ] Open the real Desktop Settings → Mobile devices, with the intended account and native local runtime. Verify startup/off status and existing devices.
- [ ] Start first-time connection; verify progress, Cancel and Reset. On a later connection, confirm the saved identity/certificate is reused.
- [ ] Scan the real QR with the physical phone camera. Confirm both screens show the same six-digit code; approve using the real Desktop button. A different/mismatched code must never be approved.
- [ ] Decline a disposable claim, refresh an invitation and test expiry; old claims must not gain access.
- [ ] Open the link with Mobile already running and from a cold standalone start. Neither path should require a development launcher or manual route refresh.
- [ ] Open an existing native Desktop conversation and a fresh test conversation. Send a bounded real-model prompt; see incremental text on the phone and the same conversation on Desktop.
- [ ] Exercise supported model/agent selection, Stop, questions/permissions, files and working changes in a disposable project.
- [ ] Interrupt the phone network during a response, restore it, and verify recovery/history without a duplicate user prompt. Exercise background/resume and Desktop sleep/resume separately.
- [ ] Revoke only the disposable phone during streaming. Further requests must be unauthorized and Send disabled; already-buffered text may arrive. Other devices must remain paired.
- [ ] Re-pair and verify the old credential remains rejected. Turn off remote access and verify it remains off after a user-controlled Desktop restart; deliberate re-enablement should preserve authorized devices.
- [ ] In an isolated profile, exercise Reset during certificate issuance and corrupt-registry recovery. Confirm remote access is off, phone credentials are revoked, and private damaged-state bytes are retained. Retry failed hosted deletion without discarding its stored identity.

Camera, physical Android/iOS, real Desktop pointer interaction, hosted transport, signed distribution and platform coverage must be reported independently. Passing fixture/source checks does not check these boxes.
