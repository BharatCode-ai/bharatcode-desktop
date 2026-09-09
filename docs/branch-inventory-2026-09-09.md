# Desktop branch inventory and discipline

Snapshot: 2026-09-09, after local merge `98aba05efe0a618759cb2fc19224c93c96f942f0`.
Scope: the WSL Desktop repository at `/home/ubuntu/bharatcode/apps/desktop` and
its registered worktrees. Separate Windows clones and other repositories are not
included. This is a point-in-time inventory, not an automatically maintained ledger.

## Canonical working branch

- Continue ordinary batch work on **local `dev`**, in the main Desktop checkout.
- `codex/batched-desktop-release` was merged normally into `dev`, preserving both
  old local documentation commits. The obsolete branch name was then deleted.
- `bf0b35e5d0` (Mac WAL startup) and `720aefeb37` (batched releases) are ancestors
  of `dev`. No runtime changes were made during consolidation.
- The former account-switch worktree is detached at the merge, not a second active
  branch. Its files/dependencies are preserved pending deliberate worktree cleanup.
- No push, force update, remote deletion, or unrelated branch merge occurred.

## Important remote divergence

Freshly fetched `origin/dev` is `5d2355e5a0b6288a9077fa5338d764051ba2707b`.
At the merge, local dev has **96 commits not on origin/dev**, and origin/dev has
**30 commits not on local dev**. The remote branch contains an alternate historical
implementation line, including early Windows recovery/auth and canonical-model
work. Ancestry alone does not establish whether those changes are obsolete or
already implemented differently. Review their net effect before a normal remote
integration. **Do not force-push local dev or blindly merge the alternate code.**
The following inventory documentation commit adds one further local-only commit.

## Cleanup proposal

- Keep `dev` as the one active integration branch.
- 28 remaining branch tips are already ancestors of dev: redundant branch
  references can be removed after confirming no owner/process still needs them.
  A merged branch tip does not make its dirty worktree safe to delete.
- 38 branches have commits not in dev: preserve them and decide keep/integrate/archive
  after a bounded diff review. Do not merge old architecture/release machinery just
  to make the branch list shorter.
- 9 worktrees contain local changes/untracked entries: preserve these first.
  No mass deletion is authorized by this inventory.
- Recommended order: review origin/dev divergence; retire unused clean merged
  references/worktrees; then triage unique historical branches by purpose.

## Local branches

“Unique” means commits reachable from that branch but not from the merged dev;
it is not a claim that all those changes remain useful or are absent by content.

| Branch                                           | Tip          | Unique | Worktree                                | Suggested disposition / last commit                                                                        |
| ------------------------------------------------ | ------------ | -----: | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `codex/access-denial-links`                      | `73216a71d1` |      0 | none                                    | MERGED; cleanup candidate. fix(app): link general access denial actions                                    |
| `codex/access-denial-links-1.15.28`              | `55cce6826b` |      0 | clean checkout                          | MERGED; cleanup candidate. chore(release): bind 1.15.28 access links cohort                                |
| `codex/account-switch-1.15.29`                   | `239d0e91a7` |      0 | none                                    | MERGED; cleanup candidate. fix(release): bind reviewed 1.15.29 candidate                                   |
| `codex/account-switch-1.15.29-evidence`          | `ad082069e6` |      0 | none                                    | MERGED; cleanup candidate. docs(desktop): record exact Windows 1.15.29 preparation                         |
| `codex/account-switch-completion`                | `9d0be61151` |      0 | none                                    | MERGED; cleanup candidate. fix(desktop): retain queued logout read barriers                                |
| `codex/af-a`                                     | `f0063489fd` |     25 | none                                    | UNMERGED; review before integrating/archiving. docs: record tranche A corrective evidence                  |
| `codex/af-bc`                                    | `c293d7275d` |     19 | none                                    | UNMERGED; review before integrating/archiving. fix(database): repair compatible schema markers             |
| `codex/af-de`                                    | `3b72624de5` |     21 | none                                    | UNMERGED; review before integrating/archiving. feat(api): enforce BharatCode-only v2 catalog               |
| `codex/af-f`                                     | `18e2e9da58` |     27 | clean checkout                          | UNMERGED; review before integrating/archiving. chore(release): checkpoint cohort authority work            |
| `codex/af-f-ui`                                  | `309505402c` |     36 | none                                    | UNMERGED; review before integrating/archiving. docs: record partial WSL runtime evidence                   |
| `codex/af-integration`                           | `093bc5ba24` |    107 | clean checkout                          | UNMERGED; review before integrating/archiving. docs(product): record unsigned Windows beta                 |
| `codex/af-private-boundary-fixes`                | `636635b4c5` |     65 | clean checkout                          | UNMERGED; review before integrating/archiving. chore(reliability): checkpoint private corrective work      |
| `codex/af-residual-evidence`                     | `0034c5287a` |     63 | none                                    | UNMERGED; review before integrating/archiving. fix(reliability): close runtime privacy boundaries          |
| `codex/canonical-model-current-dev`              | `5d2355e5a0` |     30 | dirty (0 tracked, 1 untracked entries)  | UNMERGED; preserve dirty worktree. test(product): align migration fixture with canonical model             |
| `codex/cli-output-binding-942c-review`           | `942c18371e` |      1 | none                                    | UNMERGED; review before integrating/archiving. chore(release): bind 1.15.27 CLI output cohort              |
| `codex/cli-output-drain-1.15.27`                 | `c832c38102` |      0 | clean checkout                          | MERGED; cleanup candidate. chore(release): bind 1.15.27 CLI output cohort                                  |
| `codex/cli-run-drain-1.15.25`                    | `b44709aa0e` |      0 | dirty (4 tracked, 2 untracked entries)  | MERGED; preserve dirty worktree. fix(release): enforce immutable prerelease                                |
| `codex/desktop-1.15.24-candidate-recovery`       | `70765f4e76` |      1 | clean checkout                          | UNMERGED; review before integrating/archiving. test(recovery): reproduce candidate upgrade blocker         |
| `codex/desktop-1.15.24-installer-diagnosis`      | `70a1a462db` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): isolate packaged installer failures                               |
| `codex/desktop-1.15.24-linux-updater-cohort`     | `3d117b97e9` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): preserve Linux updater metadata                                   |
| `codex/desktop-1.15.24-publish-input-contract`   | `7a3302264f` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): normalize dispatch booleans                                       |
| `codex/desktop-1.15.24-publish-mode-enum`        | `04d84dbeef` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): admit explicit publication actions                                |
| `codex/desktop-1.15.24-publish-skip-propagation` | `853de6ccc1` |      0 | none                                    | MERGED; cleanup candidate. fix(release): advance publication source admission                              |
| `codex/desktop-1.15.24-release-control`          | `43df18cb4c` |      0 | clean checkout                          | MERGED; cleanup candidate. ci(release): stage desktop 1.15.24 cohort                                       |
| `codex/desktop-1.15.24-upgrade-gate`             | `51210073a4` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): test upgrades from current beta                                   |
| `codex/desktop-1.15.24-upgrade-waiver`           | `b58ba1a1fc` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): record upgrade acceptance waiver                                  |
| `codex/desktop-1.15.25-release-control`          | `b44709aa0e` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): enforce immutable prerelease                                      |
| `codex/desktop-1.15.26-release-control`          | `3f20cb4236` |      0 | clean checkout                          | MERGED; cleanup candidate. chore(release): define 1.15.26 beta cohort                                      |
| `codex/desktop-account-auth-surface`             | `01737c1cb1` |      0 | none                                    | MERGED; cleanup candidate. fix(desktop): polish account sign-in surface                                    |
| `codex/desktop-draft-url-verification`           | `33dfd926c5` |      1 | clean checkout                          | UNMERGED; review before integrating/archiving. fix(release): verify draft asset URLs correctly             |
| `codex/desktop-release-1.15.15`                  | `7806235db0` |      0 | none                                    | MERGED; cleanup candidate. chore(desktop): bump version to 1.15.15                                         |
| `codex/lean-migration-cutover-fix`               | `1af83511ce` |      4 | clean checkout                          | UNMERGED; review before integrating/archiving. fix(opencode): close sqlite capture suffix gaps             |
| `codex/lean-migration-recovery`                  | `93643f9df6` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(recovery): enforce informational argument boundary                          |
| `codex/lean-product-core`                        | `da8d2db838` |      1 | clean checkout                          | UNMERGED; review before integrating/archiving. test(opencode): align BharatCode compatibility expectations |
| `codex/lean-release-cohort`                      | `05113b72f1` |     27 | clean checkout                          | UNMERGED; review before integrating/archiving. fix(auth): support secure Windows account storage           |
| `codex/lean-wsl-scenarios-9-10`                  | `a30c6923f2` |      0 | clean checkout                          | MERGED; cleanup candidate. style(desktop): format WSL package config                                       |
| `codex/linux-updater-metadata-fix`               | `35dd4d32bb` |      0 | none                                    | MERGED; cleanup candidate. fix(release): publish Linux updater metadata                                    |
| `codex/local-goal-share-test`                    | `5193be007e` |      1 | none                                    | UNMERGED; review before integrating/archiving. fix(desktop): re-enable BharatCode sharing                  |
| `codex/macos-recovery-diagnostic`                | `a277a17973` |      2 | clean checkout                          | UNMERGED; review before integrating/archiving. test(macos): run recovery diagnostic in active workflow     |
| `codex/macos-wal-startup-fix`                    | `bf0b35e5d0` |      0 | none                                    | MERGED; cleanup candidate. fix(storage): initialize missing macOS WAL files before startup checks          |
| `codex/platform-evidence-validator`              | `9b1bbff038` |     13 | none                                    | UNMERGED; review before integrating/archiving. fix(release): bind platform evidence provenance             |
| `codex/private-persistence-recovery`             | `403378f837` |     49 | none                                    | UNMERGED; review before integrating/archiving. fix(persistence): harden private recovery surfaces          |
| `codex/private-persistence-transaction`          | `7ef5e246a9` |     45 | none                                    | UNMERGED; review before integrating/archiving. fix(persistence): make identity migration transactional     |
| `codex/reliability-audit-spec`                   | `5e03397f38` |     17 | none                                    | UNMERGED; review before integrating/archiving. docs: plan reliability corrective implementation            |
| `codex/reliability-evidence-clearance`           | `4b5f369955` |     15 | none                                    | UNMERGED; review before integrating/archiving. docs: record reliability source clearance                   |
| `codex/reliability-foundation`                   | `44b7e90c1a` |     12 | none                                    | UNMERGED; review before integrating/archiving. feat: build BharatCode reliability foundation               |
| `codex/rf-apple-native-signing`                  | `8548955939` |     74 | dirty (3 tracked, 0 untracked entries)  | UNMERGED; preserve dirty worktree. test(release): emulate isolated Apple provider boundaries               |
| `codex/rf-inherited-directory-plan`              | `18e5bc860a` |     84 | none                                    | UNMERGED; review before integrating/archiving. docs: close inherited authority plan review                 |
| `codex/rf-migration-db-recovery`                 | `74d199d8af` |     82 | dirty (1 tracked, 0 untracked entries)  | UNMERGED; preserve dirty worktree. docs: plan inherited directory authority                                |
| `codex/rf-release-authority-cohort`              | `84a33e782a` |     41 | dirty (2 tracked, 2 untracked entries)  | UNMERGED; preserve dirty worktree. fix(release): close approval observer provenance                        |
| `codex/rf-runtime-security-ui-identity`          | `7fb0a0b467` |     74 | dirty (32 tracked, 3 untracked entries) | UNMERGED; preserve dirty worktree. fix(persistence): close content contract review gaps                    |
| `codex/rf-windows-wsl-runtime`                   | `7e4ab7ceba` |     83 | dirty (1 tracked, 0 untracked entries)  | UNMERGED; preserve dirty worktree. fix(desktop): contain WSL authority crashes                             |
| `codex/server-env-contract`                      | `dc5684cd54` |     14 | none                                    | UNMERGED; review before integrating/archiving. fix(server): enforce BharatCode environment contract        |
| `codex/single-qwen-client-surface`               | `5ae3d6b7f8` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(product): reject stale BharatCode model config                              |
| `codex/subscription-required-error-1.15.25`      | `94c7dd0fa3` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(auth): surface subscription-required model errors                           |
| `codex/windows-jit-source-resolution`            | `e6ba4704f1` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(release): close signed cohort JIT provenance                                |
| `codex/windows-recovery-actions`                 | `60b0dc340f` |      0 | clean checkout                          | MERGED; cleanup candidate. ci(release): bind hotfix acceptance source                                      |
| `codex/windows-startup-hotfix-1.15.22`           | `86bf28a83d` |      0 | clean checkout                          | MERGED; cleanup candidate. fix(desktop): load recovery UI before startup gate                              |
| `dev`                                            | `98aba05efe` |      0 | dirty (0 tracked, 1 untracked entries)  | KEEP: canonical. merge: consolidate desktop release batch into dev                                         |
| `opencode/brave-canyon`                          | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/brave-eagle`                           | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/kind-falcon`                           | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/mighty-moon`                           | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/proud-island`                          | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/quiet-rocket`                          | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/silent-tiger`                          | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |
| `opencode/silent-wolf`                           | `a7ca9a5c83` |     11 | none                                    | UNMERGED; review before integrating/archiving. feat(workspace): harden lifecycle and session provenance    |

## Worktrees with local state to preserve

Counts are porcelain entries (an untracked directory may contain many files).

| Worktree                                                                          | Branch                                  | Tracked changes | Untracked entries |
| --------------------------------------------------------------------------------- | --------------------------------------- | --------------: | ----------------: |
| `/home/ubuntu/bharatcode/apps/desktop`                                            | `dev`                                   |               0 |                 1 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/canonical-model-current-dev`     | `codex/canonical-model-current-dev`     |               0 |                 1 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/canonical-model-held-candidate`  | `DETACHED`                              |               2 |                 0 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/cli-run-drain-1.15.25`           | `codex/cli-run-drain-1.15.25`           |               4 |                 2 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/rf-apple-native-signing`         | `codex/rf-apple-native-signing`         |               3 |                 0 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/rf-migration-db-recovery`        | `codex/rf-migration-db-recovery`        |               1 |                 0 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/rf-release-authority-cohort`     | `codex/rf-release-authority-cohort`     |               2 |                 2 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/rf-runtime-security-ui-identity` | `codex/rf-runtime-security-ui-identity` |              32 |                 3 |
| `/home/ubuntu/bharatcode/apps/desktop/.worktrees/rf-windows-wsl-runtime`          | `codex/rf-windows-wsl-runtime`          |               1 |                 0 |

The main checkout's untracked `.superpowers/` directory was present before the
merge and remains untouched. Other dirty worktrees were inspected for status only.

## Rules going forward

1. Work on dev for sequential fixes. No branch per fix, review, evidence update,
   or transient build failure.
2. A separate branch needs explicit user direction or approved parallel ownership;
   record its purpose, owner, and merge target when it is created.
3. Before ending work, report branch/head, local vs pushed, merged vs unmerged,
   and any remaining dirty state.
4. After integration, verify ancestry and clean worktree/process ownership before
   removing the obsolete branch/worktree. Never delete unique or dirty work silently.
5. Freeze release candidates by exact commit/tag, not by spawning more branches.
