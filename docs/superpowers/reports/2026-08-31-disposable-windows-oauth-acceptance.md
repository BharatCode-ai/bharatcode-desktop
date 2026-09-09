# Disposable Windows OAuth acceptance — approval required

Do not install this candidate in the user's current Windows account or replace
the existing installation. This procedure has **not** been executed. Provisioning
a disposable local Windows account/host, installing there and changing that
account's protocol association require explicit user approval first. Use only an
explicitly authorized BharatCode test account; the user completes browser login.

## Exact local diagnostic artifact

- Source: `b7b443b61b19fc62477fd22beffebbb9d9c13583`.
- Version/channel: `1.15.22` / `beta`.
- Installer:
  `C:\Users\Shrey Gupta\AppData\Local\Temp\bc-diagnostic-b7b443\bharatcode-desktop-win-x64-b7b443.exe`.
- Bytes: `221035869`.
- SHA-256: `4e7cc6700222d00cef659f2ed1a0028e4967086eaab27c251b1ed557c828dfb8`.
- Authenticode: **NotSigned**. Local diagnostic artifact, not a release or trusted
  signed installer. Never automate bypass of a Windows trust/security prompt.
- app.asar:
  `562367e2e03e7a7e4745f231b82bde5518798b6c528354799b9d6bfbd51183f0`.
- Packaged recovery CLI:
  `dfb644578c293824297ace65169457fc84dc047fe8308a74805700f5bcb7229b`.
- WSL runtime:
  `f99fd154753991a304626998d33be7bb27afa4846f8279f5bf310d0d615a5ae5`.

The prior 36e1 diagnostic installer is superseded for this test. No installer was
launched when generating these hashes. Source/evidence documentation descendants
must not be substituted for the exact packaged source identity above.

## After explicit approval

1. Sign into the disposable Windows account. Verify the installer hash there,
   install normally for that account and launch from that installation. Do not
   use `BHARATCODE_TEST_ONBOARDING`, test-home, HOME/USERPROFILE/AppData/XDG
   overrides, portable launchers, copied production credentials or pre-hardened
   application directories. Normal, stable userData is essential.
2. Verify the account's `bharatcode` protocol handler resolves to this installed
   EXE, and match installed app.asar/recovery/runtime hashes above. Record only
   executable identity/process IDs and sanitized state. Do not dump process
   command lines containing callbacks. If the handler or artifact differs, stop.
3. In this empty test profile, complete recovery if requested. Confirm visible,
   styled actions and a responsive main window. Start **one new** sign-in from
   this instance. Discard all older pending flows; do not reuse any prior URL,
   code or state. Complete the browser login manually using the authorized test
   BharatCode account. Confirm it uses the intended ordinary browser profile.
4. Verify the callback reaches the initiating installed instance with its
   original pending PKCE/state and stable profile, then reaches signed-in UI.
   Close and relaunch the installed application; it must remain signed in.
   Exercise test-account refresh/rotation and local logout, then relaunch and
   confirm signed out. Inspect protection through safe ACL metadata, not token
   output. Any unsafe existing-store state must fail with a clear storage error;
   do not rewrite existing parent ACLs to manufacture a pass.
5. Independently use synthetic callback fixtures for wrong-state and replay
   rejection and secret-free event logging; never replay the actual browser code.
   Record the exact artifact/source, outcome, times and sanitized observations.
   This still does not satisfy the separate formal JIT/WSL acceptance gate.

Stop on callback-recipient mismatch, generic recovery loop, unresponsive action,
storage error, failed persistence, unexpected credential-bearing logs or any
unexpected access to another profile. Do not click Start Fresh on the user's
existing profile or change production OAuth routing to work around the test.

After evidence review, any uninstall/account cleanup must be limited to the
explicitly approved disposable account/host. Keep the original user installation,
recovery data and credentials untouched. Public downloads and promotion remain
disabled until all separately required release gates pass.
