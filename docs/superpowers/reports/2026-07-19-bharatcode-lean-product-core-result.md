# BharatCode Lean Product Core Result

## Checkpoint identity

- Baseline: `01737c1cb123909c2ca0626d3fc2ce475fe7c599`
- Product Core implementation head: `3599b5239ae76be88e9daf9f9ddc93b0d935fd18`
- Branch: `codex/lean-product-core`
- Baseline delta: 118 changed paths; 8,008 insertions and 4,138 deletions
- Ancestry: `git merge-base --is-ancestor 01737c1cb123909c2ca0626d3fc2ce475fe7c599 3599b5239ae76be88e9daf9f9ddc93b0d935fd18` exited `0`
- Diff integrity: `git diff --check 01737c1cb123909c2ca0626d3fc2ce475fe7c599..3599b5239ae76be88e9daf9f9ddc93b0d935fd18` exited `0`

## Clean commit stack

1. `7f3e12648023d6cc1cf860c1302fca4eb84d7526` — `feat(cli): ship complete BharatCode runtime`
2. `5af7ed85d9fccdccd407c5ca65880c7c5d57f9d7` — `feat(config): adopt BharatCode runtime identity`
3. `efec77e1d3e188365e4cf1d42df55ec27f81ab21` — `feat(auth): share one BharatCode account service`
4. `bb078d3a994062227381d92b3a48e66147ee2a8b` — `feat(provider): enforce BharatCode live catalog`
5. `0e3f6e386cb8fc8cea286308df0c0bb41448a1a9` — `feat(desktop): use shared BharatCode account runtime`
6. `3599b5239ae76be88e9daf9f9ddc93b0d935fd18` — `test(product): prove BharatCode core vertical slice`

## Exact verification

| Command                                                                                                                                                                                                                 | Result                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `(cd packages/opencode && bun test test/provider/provider.test.ts test/cli/plugin-auth-picker.test.ts)`                                                                                                                 | 98 pass, 0 fail, 224 assertions                                   |
| `(cd packages/opencode && bun test test/product/lean-product-core.test.ts test/distribution/lean-package.test.ts test/bharatcode/account.test.ts test/bharatcode/catalog.test.ts test/product/provider-policy.test.ts)` | 54 pass, 0 fail, 160 assertions                                   |
| `(cd packages/opencode && bun typecheck)`                                                                                                                                                                               | PASS (`tsgo --noEmit`)                                            |
| `(cd packages/desktop && bun test)`                                                                                                                                                                                     | 48 pass, 0 fail, 167 assertions                                   |
| `(cd packages/desktop && bun typecheck)`                                                                                                                                                                                | PASS (`tsgo -b`)                                                  |
| `(cd packages/app && bun test)`                                                                                                                                                                                         | 371 pass, 0 fail, 965 assertions                                  |
| `(cd packages/app && bun typecheck)`                                                                                                                                                                                    | PASS (`tsgo -b`)                                                  |
| `(cd packages/opencode && bun test test/product/lean-product-core.test.ts)` from committed Task 7 head                                                                                                                  | 1 pass, 0 fail, 18 assertions; receipt source is exact Task 7 SHA |
| `prettier --write` on the 12 Task 7 paths                                                                                                                                                                               | PASS                                                              |
| `git diff --check`                                                                                                                                                                                                      | PASS                                                              |

All generated state stayed in lane-owned workspace temp roots: `.tmp/lean-task7` for verification logs and `.tmp/lean-product-core-acceptance` for acceptance homes, projects, package tarballs, and build output. Generated state was removed after verification.

## Scenario receipts

1. **Fresh CLI install — PASS.** The acceptance runner packs the local npm tarball, installs it into a blank home, and exercises the installed `bharatcode` entrypoint. No OpenCode binary is delegated to.
2. **First sign-in — PASS.** PKCE completes through the shared BharatCode account service. CLI and Desktop observe stable `sub` `usr_product_core` from the same isolated credential store. The Desktop identity projection uses `createBharatCodeAccountClient` and does not expose reusable credentials.
3. **Coding workflow — PASS.** The CLI/TUI surface uses `createOpencodeClient(@opencode-ai/sdk/v2)` and the Desktop/app surface uses `createSdkForServer(packages/app/src/utils/server)` against one authenticated listener and one temporary project. The observed flow creates one session, streams text and an edit tool call, changes `answer.txt` from `before` to `after`, runs `printf shell-ok > command.txt`, restarts the listener, and reads the same five-message session through the other adapter.
4. **Catalog fail-closed — PASS.** The Desktop adapter observes exactly one authenticated live BharatCode coding model. The mandatory compatibility suite remains green only through explicit internal generic-layer construction; shipped server/app/plugin boot performs no ModelsDev discovery.
5. **Account lifecycle — PASS.** Both titlebar branches pass the shared account-state suite. Desktop logout clears the shared account, and CLI subsequently observes no account ID.
8. **BharatCode-only boundary — PASS.** The attempt recorder derives fetch, connect, spawn, schema, provider, and authorization targets from executed operations. `forbiddenAttempts` and `shareAttempts` are empty. ShareNext fails before resolving a target, provider-connect/GitHub generic commands are unregistered, and isolated HOME/project cleanup is asserted.

## Classified residuals

- `BETA_BLOCKER`: none.
- `POST_BETA_HARDENING`: none in Product Core scenarios 1–5/8.
- `EXTERNAL_EVIDENCE`: none claimed. This report does not evaluate Migration/Recovery, Windows/WSL, macOS signing/notarization, artifact cohorts, publication, or deployment.

## Machine-readable requirement delta

```json
{
  "baseline": "01737c1cb123909c2ca0626d3fc2ce475fe7c599",
  "head": "3599b5239ae76be88e9daf9f9ddc93b0d935fd18",
  "changed_paths": 118,
  "receipt_test": "lean-product-core-scenarios-1-5-8",
  "scenarios": {
    "1": "PASS",
    "2": "PASS",
    "3": "PASS",
    "4": "PASS",
    "5": "PASS",
    "8": "PASS"
  },
  "requirements": {
    "fresh_cli_install": "SATISFIED",
    "shared_pkce_identity": "SATISFIED",
    "shared_session_vertical": "SATISFIED",
    "bharatcode_catalog_fail_closed": "SATISFIED",
    "shared_account_lifecycle": "SATISFIED",
    "bharatcode_only_boundary": "SATISFIED",
    "sharenext_disabled": "SATISFIED",
    "provider_compatibility_regression": "CLOSED"
  },
  "findings": {
    "BETA_BLOCKER": [],
    "POST_BETA_HARDENING": [],
    "EXTERNAL_EVIDENCE": []
  }
}
```
