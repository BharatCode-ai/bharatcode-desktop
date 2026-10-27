# Self-hosted tunnel integration verification — 2026-10-25

The implementation uses the existing OpenTunnel SDK against `https://tunnel.bharatcode.ai` and retains explicit Desktop-approved pairing. Tunnel service reference: `fe7dfa73b35ebb035ba42a62482ec230a7e1a8bf`. Desktop base: `695c2d956e6bc6f27b881a1cdbe0a7acd0764bc3`; Mobile base: `5403d872dbb85d9b42856312a9c503edf7982cae`.

## October 27 correction

The reset claim below originally covered the deletion helper, not cancellation through the Desktop action queue. The October 27 audit reproduced that queue wait and an optional-storage startup failure. Follow-up fixes and current acceptance boundaries are documented in [mobile-access-acceptance.md](mobile-access-acceptance.md). Results below remain historical evidence for the October 25 source and do not qualify a later build.

## Source verification

| Gate | Result |
| --- | --- |
| Mobile TypeScript and ESLint | Passed |
| Mobile Jest suite | 71 passed, 12 suites |
| Existing certificate/security regressions | 15 passed |
| Mobile and connector npm audits | 0 known vulnerabilities |
| Expo dependency compatibility | Dependencies up to date |
| Connector Node suite | 44 passed |
| Desktop integration generator, applied twice to a clean pin | 2 passed |
| Linux browser helper regressions | 3 passed |
| Desktop package TypeScript and release configuration | Passed |
| App package TypeScript | Passed |
| Full Desktop workspace typecheck | 19 tasks passed in isolated sibling checkout |
| Desktop package source suite | 168 passed; focused owned-renderer authorization checks: 8 passed / 40 assertions |
| App package unit suite | 748 passed, 1 pre-existing failure; see below |

`packages/app/src/i18n/parity.test.ts` fails because the Arabic UI dictionary lacks `ui.message.outputLimit`, `ui.message.outputLimit.reasoning`, `ui.message.outputLimit.partial`, and `ui.message.outputLimit.tool`. A fresh clean clone at the Desktop base reproduces the exact 748-pass/1-fail result. This integration does not modify those UI files or suppress the failure. The mobile settings keys use the repository's existing shared English fallback pending reviewed translations.

One parallel Desktop test run observed a timing-sensitive failure in the unchanged `src/main/stdio.test.ts` test `compiled guard survives real Node stdout and stderr pipe disconnects`: its unguarded child delivered an extra `alive` message before exiting. The focused six-test stdio suite and subsequent full 168-test Desktop suite both passed. No test was suppressed and those stdio files were not changed.

## Security review

An independent read-only code reviewer checked the pinned tunnel trust-boundary document, SDK lifecycle, pairing/approval, gateway route/authentication boundaries, persistence, streaming revocation, native link parser, and trusted Desktop IPC. No actionable authentication bypass was found in that scope. This was a focused code review, not a repository-wide security audit.

The review identified a reset path that could wait for a pending certificate. Reset now uses the stored authenticated tunnel identity to delete directly through the SDK API, with a 30-second operation bound. A regression exercises actual pending storage and the SDK HTTP request, without completing a certificate. Another regression verifies Desktop immediately reflects phone-initiated unpairing. The migration regression pins the separate self-hosted identity store so upstream credentials cannot be reused against the new service.

A final connection-state regression reproduced idle background activity failures leaving Desktop marked connected; the Mobile client now shows offline/reconnecting, retries identity health, retains pairing, and clears the notice on recovery.

Other source regressions exercise expired/replayed/declined claims, bounded public-link enrollment, mandatory explicit approval, invalid origins and malformed/deceptive URLs, wrong device credentials, browser origins, spoofed localhost/forwarding headers, sensitive route denial, provider-secret projection, registry persistence, revocation during requests/streams, readable status and cancellable slow issuance. Native fetch explicitly omits cookies and rejects redirects. See [the documented boundary](mobile-access-trust-boundary.md).

The installed-runtime follow-up exposed two Mobile bugs: a warm pairing link could open the screen without submitting its claim, and long plain replies created a native Text view per Markdown leaf. Native intent routing now validates the original URI before passing it to pairing, with a per-delivery identifier so the same public link can be retried after cancellation. Plain paragraph rendering now joins text leaves while preserving rich Markdown children and heading styles. Regressions cover real store claim submission, repeated intents, malformed links without credential propagation, all 600 reply lines with bounded native view growth, rich spans, and three heading levels. Independent review caught the initial heading-style regression; the revised implementation resolves it. A sustained real-model run also exposed UI starvation from synchronously publishing every streamed text delta. The store now accumulates all deltas and publishes at most once per 100 ms, avoiding a full history reload for each text delta while lifecycle events still reconcile authoritative state. A 200-delta regression reproduces 200 notifications before the fix; the revised path retains every character with bounded notifications. Separate coverage ensures queued text cannot publish after navigation or revocation, and durable replay still reconciles text through history. Independent source review found no actionable issue in this change. The final exact `npm run check` passed TypeScript, ESLint, all 71 Jest tests and all 15 certificate/security checks.

## Runtime qualification

The designated `gpt-6-luna`/max qualification delegates own runtime builds and native/hosted testing. Source tests above do not prove real certificate issuance, physical camera scanning, network changes or native streaming.

Observed hosted results before the UI/native handoff:

- The real hosted service completed first-time certificate issuance in approximately six minutes. The SDK delivered 195 progress callbacks; pending identity state remained private and persisted through issuance.
- A subsequent connection with the stored certificate attached in approximately 300 ms.
- The public pairing link contained only origin/Desktop identity. A claim remained pending until explicit Desktop approval with matching confirmation, then authenticated health and protected session requests succeeded.
- Real hosted SSE delivered the expected projected assistant text delta from an authenticated deterministic sidecar fixture. This proves the transport/gateway path; it is not a production model-generation test.
- No bearer, wrong bearer, cookie-only, forwarded-header-only, and `Host: localhost` plus spoofed forwards returned 401. A browser Origin with a valid bearer returned 403.
- Closing/recreating the connector in the same Node process retained the same origin, Desktop/device IDs, accepted phone bearer and digest of all five identity/certificate files. This is connector lifecycle retention evidence; a full Desktop process restart is recorded separately below.
- Re-pairing issued a working replacement credential while the old revoked credential remained rejected. Reset deleted the hosted test identity. The initial harness then made a redundant authenticated fetch after reset, which failed because the tunnel had been removed; this is a harness-order limitation, not a passing post-reset authenticated request.

Integrated Desktop results:

- A second fresh identity provisioned through the real Electron main-process/preload IPC in approximately five minutes. Status snapshots showed certificate progress while issuance remained pending. The test used the existing Desktop sidecar, rather than creating another agent.
- Native Android claimed the public link and received access only after a matching-code approval through the actual owned-renderer IPC. Authenticated health and session requests then succeeded. The QA Desktop profile was signed out, so visible Settings/approval UI remained behind its existing account gate; approval was invoked through trusted IPC rather than by borrowing credentials or bypassing that gate.
- On the real Desktop tenant, unauthenticated, wrong-token, cookie-only, forwarded-header and localhost-Host spoof requests were rejected. A browser-origin request with a valid bearer was rejected.
- A disposable approved device created an empty session in the real isolated sidecar, then opened its hosted SSE endpoint: HTTP 200 and the initial connected comment arrived. Revoking that device through Desktop IPC removed it, made the old bearer receive 401, and actually aborted the stream after 13 buffered bytes drained. No provider/model call was made.
- A full isolated Electron stop and fresh process launch restored remote access as enabled and connected, with the same public origin, Desktop ID, one saved Android device, and identical SHA-256 digests for the five identity/certificate files and device registry. Android recovered with its existing credential and no new pairing.

Android emulator results (API 35, x86_64):

- An isolated development APK used a separate QA application ID. Opening the Desktop link reached native pairing, matching-code approval completed, and authenticated Desktop chats/session data rendered.
- A launcher relaunch restored the saved computer from native storage and reconnected without a new claim. A Metro JavaScript reload left the app on its existing pairing route with a Back to chats action; this was route state, rather than credential loss.
- After the full Desktop process restart, Android showed Offline and the saved-draft reconnect banner, then returned to Connected with the original credential.
- Enabling airplane mode on the QA emulator caused an actual background request failure and visible Offline/saved-draft notice within two seconds. Restoring its network returned the same paired computer to Connected within six seconds.
- An authenticated empty real-sidecar conversation rendered its composer and file/working-change controls after recovery, without sending a prompt. Native SSE server acceptance and incremental text rendering were not directly observed in this run; the separate hosted fixture and real-sidecar stream tests above cover those transport/termination boundaries.
- Revoking the phone through Desktop IPC produced “This phone is no longer authorized. Pair again.” in native UI. The saved computer metadata remained; no new pairing was performed after revocation. A subsequent native force-stop and launcher relaunch created a new app process and restored the same revoked state within approximately six seconds.
- A malformed link was rejected natively before a claim. Warm link dispatch worked. Cold link dispatch first opened the Expo development launcher until its remembered Metro server was selected; standalone cold-start behavior remains unverified.

The initial isolated-profile run above did not verify production model generation or the signed-in installed Desktop. The follow-up below uses the installed native application and its existing account/session. Physical camera scanning, physical Android/iOS and signed distribution remain unverified. No existing installed Mobile app was replaced by the separate QA package.

## Installed native Desktop and real-model follow-up

The follow-up used the installed native Fedora Desktop build, its existing signed-in profile and existing sidecar, plus the separate API 35 Android development QA package. One user-approved controlled Desktop restart restored the same tunnel identity/certificate and paired-device registry. That Desktop process remained running throughout subsequent testing. Approval used the actual owned-renderer preload IPC with matching confirmation codes; pointer-driven Desktop approval UI is not claimed. Three pre-existing paired devices were preserved; disposable QA devices were handled separately.

- A public pairing link submitted a claim and connected Android only after explicit matching-code Desktop approval. Opening the real public link in the already-running Android app also passed: it automatically submitted a pending claim, displayed the matching confirmation and connected only after approval. This used the native-intent fix above; Metro needed its route context refreshed to include the newly added file in the development bundle. No manual paste was used for that final warm-link test.
- Real account-backed Qwen 3.8 27B requests ran through the phone's authenticated HTTPS tunnel, gateway and existing Desktop sidecar. The completed answers included the requested 1–80, 1–200, 1–120 and 1–1000 sequences. These were model calls, rather than fixture SSE events.
- During the 200-line request, Android Wi-Fi/data were disabled after admission. Mobile showed Offline and its saved-draft/reconnect notice. Desktop completed generation while the phone was offline. Restoring the network recovered the paired connection, cleared the notice and displayed the completed answer; the authoritative session retained one user/assistant pair for that request, without duplicate admission.
- The 1000-line stress run exposed UI starvation described above. After the rendering/store fixes, Mobile rendered all 1000 lines in one numeric TextView and Back navigation worked. The first live sampler omitted UIAutomator errors, so its zero counts are invalid measurements and are not used as proof of missing text or successful incremental growth.
- Incremental real-model rendering passed on the revised source without instrumentation. A read-only React DevTools probe measured the current assistant's committed `Message` props growing from 46 to 114 text characters, with screenshots showing the visible tail advance from line 18 to line 40. The matching assistant's authenticated Desktop lookup explicitly reported incomplete after each screenshot. These pre-revocation samples were approximately 8.24 and 10.17 seconds after sending the prompt. No accessibility-idle assumption or final-response timing was used to infer streaming.
- Desktop revoked only the disposable QA phone while that response was still incomplete. Mobile automatically switched to Offline with “This phone is no longer authorized. Pair again.” in approximately 1.97 seconds, and native accessibility confirmed Send was visible but disabled. Neither app was restarted. Twelve characters already in flight rendered before the phone's text stabilized at 126 characters. After Desktop finished the 1,893-character answer, eleven further observations over 20.27 seconds confirmed the phone stayed offline/unauthorized at that same partial text, with no further reply growth. Revocation does not retract buffered bytes or automatically cancel work owned by Desktop. The device list returned from four entries to the original three. Earlier fresh requests with revoked credentials also returned the re-pair notice.

Qualification processes ran under a shared 6 GiB memory cap and two-core CPU budget; the emulator child was capped at 4 GiB with 1.5 GiB guest RAM. Earlier attempts that exceeded smaller emulator child caps were discarded. The later UI starvation was observed without a new memory-limit/OOM event.

No release publication or store submission is part of this work. Physical Android/iOS, camera scanning and signed distribution remain separate qualification tiers.
