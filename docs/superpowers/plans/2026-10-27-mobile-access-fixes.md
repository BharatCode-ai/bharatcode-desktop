# Mobile Access Reliability Implementation Plan

**Goal:** Resolve the October 27 audit defects while preserving existing pairing authorization and leaving final physical-device acceptance to the user.

**Architecture:** Keep mobile access optional: constructor creates the controller without touching persistent state; guarded restoration and explicit actions load the registry. Preserve corrupt state and fail closed for phone access. Cancel provisioning before queueing reset/disable. Keep native default-sidecar scope explicit.

**Constraints:** No account/relay architecture changes, no restart of existing Desktop/server, no push/issue/PR update without subsequent approval. Primary implements; gpt-6-luna/max owns qualification. Repository package-local commands and typed i18n remain in force.

- [x] Add failing production-controller regressions for malformed/unavailable storage, reset during issuance and queued cancellation; implement lazy guarded storage loading and cancellation.
- [x] Add focused settings interaction coverage for provisioning/reset, matching-code approval, errors and device management. Preserve user-confirmation behavior and handle clipboard failures.
- [x] Address portable file directory reading if implementation can avoid Windows directory handles; keep actual platform qualification distinct.
- [x] Keep historical results dated; document corrected behavior, supported runtime scope, local submission drafts and user acceptance steps.
- [ ] Run implementation checks, independent review and delegated exact-source qualification. Record inherited localization failure instead of expanding unrelated scope.
