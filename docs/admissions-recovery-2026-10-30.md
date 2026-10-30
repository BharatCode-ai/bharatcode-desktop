# Admissions recovery review — 2026-10-30

Addresses Shrey's Desktop #60 review and the follow-up on merged Mobile #1.

## Behavior

- Invalid JSON and invalid journal structures fail closed and report mobile storage failure. Pairing failure preserves the original file.
- Explicit Reset stops access, privately quarantines invalid admissions bytes, revokes device access, and removes tunnel identity. A durable recovery marker is written before quarantine, so a process crash cannot silently reopen without lost-history protection. A failed storage operation rejects Reset and reports an error.
- Healthy journals are never removed by Reset; unresolved forwarding records remain unresolved.
- After corruption recovery, old conversations remain readable. An exact matching stored user message can reconcile without sending. Unknown or mismatched old prompts are rejected with instructions to inspect Desktop and start a new conversation on the phone.
- New conversations created through the connector use a fresh random identity, reject caller-selected IDs, and are recorded durably before they can send. This avoids relying on wall clocks to distinguish old/new conversations. Restart and healthy Reset retain that proof; recovering a newly corrupt journal loses the allowlist and blocks those now-uncertain sessions too.
- The Mobile source and Desktop generated source/tests match byte-for-byte. The pinned integration generator is tested independently on its documented source pin; the Desktop PR follow-up is also merged locally with current dev `f8c7feacae8a8cf89d9b9cb05a780e306f845d7d`.

## Evidence

The original tests failed before the recovery implementation. A fresh source reviewer then reproduced a backward-clock duplicate-delivery risk in the first timestamp design. The clock regression failed before replacing that design with durable fresh session identities, then passed afterward.

| Check | Result |
| --- | --- |
| Mobile connector suite | 65 passed |
| Mirrored Desktop connector suite | 65 passed |
| Real local HTTP pairing/recovery/prompt/reset/restart regression | Passed inside both connector suites |
| Mobile Jest / security / TypeScript / lint | 76 / 15 passed; typecheck and lint passed |
| Desktop source suite on recovery branch | 170 passed |
| Recovery-branch server suite | 324 passed; 2 existing skips |
| Actual Desktop HTTP routes/database + local test-model recovery | Passed; two intended prompts, two model calls, two upstream submissions; retries did not add submissions |
| App unit suite on recovery branch | 748 passed; 1 baseline Arabic UI parity failure |
| App browser-condition suite | 55 passed |
| Mobile Settings Chromium cases | 5 passed |
| Integration generator / host browser helper | 3 / 3 passed |
| Desktop/app/e2e/server typechecks | Passed |

The app unit failure is `i18n parity > non-English locales have every English key and required plural variants`: four missing `ui.message.outputLimit*` keys in Arabic. It was reproduced from the current dev dictionaries/test in an isolated temporary directory. This change does not alter the parity test or UI locale dictionaries.

These checks establish source and local fixture behavior. They do not establish installed Electron, physical Android/iOS, native Windows/macOS, store signing, or release acceptance. No package, installation, deployment, push, PR, or review reply was made for this follow-up.

## Additional actual-server verification

The Desktop `packages/opencode/test/server/httpapi-session.test.ts` regression uses the actual HTTP routes and database with the mirrored connector and a local deterministic model server. It checks an original prompt/reply, corrupt journal rejection, explicit recovery, reconciliation of the original stored retry, 409 rejection of unknown old delivery, connector-generated session creation, the new conversation reply, and Reset/reopen retry. Both upstream submission counts and model-call counts remain exactly two for the two intended prompts. This complements the gateway pairing fixture; it does not substitute for an installed Electron/phone test. The complete recovery-branch server suite passed 324 tests with two existing skips.
