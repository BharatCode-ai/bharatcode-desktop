# Self-hosted tunnel integration verification — 2026-10-25

The implementation uses the existing OpenTunnel SDK against `https://tunnel.bharatcode.ai` and retains explicit Desktop-approved pairing. Tunnel service reference: `fe7dfa73b35ebb035ba42a62482ec230a7e1a8bf`. Desktop base: `695c2d956e6bc6f27b881a1cdbe0a7acd0764bc3`; Mobile base: `5403d872dbb85d9b42856312a9c503edf7982cae`.

## Source verification

| Gate | Result |
| --- | --- |
| Mobile TypeScript and ESLint | Passed |
| Mobile Jest suite | 53 passed, 10 suites |
| Existing certificate/security regressions | 15 passed |
| Mobile and connector npm audits | 0 known vulnerabilities |
| Expo dependency compatibility | Dependencies up to date |
| Connector Node suite | 44 passed |
| Desktop integration generator, applied twice to a clean pin | 2 passed |
| Linux browser helper regressions | 3 passed |
| Desktop package TypeScript and release configuration | Passed |
| App package TypeScript | Passed |
| Full Desktop workspace typecheck | 19 tasks passed in isolated sibling checkout |
| Desktop package source suite | 168 passed |
| App package unit suite | 748 passed, 1 pre-existing failure; see below |

`packages/app/src/i18n/parity.test.ts` fails because the Arabic UI dictionary lacks `ui.message.outputLimit`, `ui.message.outputLimit.reasoning`, `ui.message.outputLimit.partial`, and `ui.message.outputLimit.tool`. A fresh clean clone at the Desktop base reproduces the exact 748-pass/1-fail result. This integration does not modify those UI files or suppress the failure. The mobile settings keys use the repository's existing shared English fallback pending reviewed translations.

One parallel Desktop test run observed a timing-sensitive failure in the unchanged `src/main/stdio.test.ts` test `compiled guard survives real Node stdout and stderr pipe disconnects`: its unguarded child delivered an extra `alive` message before exiting. The focused six-test stdio suite and subsequent full 168-test Desktop suite both passed. No test was suppressed and those stdio files were not changed.

## Security review

An independent read-only code reviewer checked the pinned tunnel trust-boundary document, SDK lifecycle, pairing/approval, gateway route/authentication boundaries, persistence, streaming revocation, native link parser, and trusted Desktop IPC. No actionable authentication bypass was found in that scope. This was a focused code review, not a repository-wide security audit.

The review identified a reset path that could wait for a pending certificate. Reset now uses the stored authenticated tunnel identity to delete directly through the SDK API, with a 30-second operation bound. A regression exercises actual pending storage and the SDK HTTP request, without completing a certificate. Another regression verifies Desktop immediately reflects phone-initiated unpairing. The migration regression pins the separate self-hosted identity store so upstream credentials cannot be reused against the new service.

A final connection-state regression reproduced idle background activity failures leaving Desktop marked connected; the Mobile client now shows offline/reconnecting, retries identity health, retains pairing, and clears the notice on recovery.

Other source regressions exercise expired/replayed/declined claims, bounded public-link enrollment, mandatory explicit approval, invalid origins and malformed/deceptive URLs, wrong device credentials, browser origins, spoofed localhost/forwarding headers, sensitive route denial, provider-secret projection, registry persistence, revocation during requests/streams, readable status and cancellable slow issuance. Native fetch explicitly omits cookies and rejects redirects. See [the documented boundary](mobile-access-trust-boundary.md).

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

Physical camera scanning, physical Android/iOS, signed distribution, production model generation, and visible Desktop Settings/approval behind real account login remain unverified. No existing installed Mobile app was replaced by the separate QA package.

No release publication or store submission is part of this work. Runtime tests use isolated Desktop profiles and a separate Android QA application ID. Physical Android/iOS and signed distribution remain separate qualification tiers.
