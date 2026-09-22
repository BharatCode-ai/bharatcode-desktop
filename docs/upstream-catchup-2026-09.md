# Upstream catch-up — status

Branch `chore/upstream-catchup-2026-09`, cut from `upstream/dev` @ `fee476bb90`
(anomalyco/opencode, 2026-09-19).

We had not synced since the fork point `6b03be5468` (2026-05-23): upstream was
2,423 commits ahead, we were 298 ahead. This is a re-fork, not a merge — start
from upstream and re-apply our work theme by theme, evaluating each one, rather
than resolving 499 overlapping files at once.

## Where it stands

12 commits. Every one green at the point it landed: `bun turbo typecheck --force`
19/19, and the suites for whatever that commit touched.

| | |
|---|---|
| net vs `upstream/dev` | 1,721 files, +12,786, −503,734 |
| our tests passing | 196 (auth, bharatcode, migration, provider, goal) |
| `packages/core` | 1,100 pass / 0 fail |
| upstream provider suite | 713 pass / 5 fail — **identical to baseline** |
| upstream session + agent | 462 pass / 0 fail — identical to baseline |

The 5 provider failures are pre-existing and auth-dependent (they want real
bearer tokens); I confirmed them against a stashed baseline before and after.

## Done

1. **Package prune** — keep 20 workspace packages, drop 11. Re-derived as the
   dependency closure of what we ship over upstream's *current* graph rather
   than replaying the old list.
2. **Root prune** — the whole SST surface, `github/`, `sdks/vscode`,
   `artifacts/`, `perf/`, and the nix packaging.
3. **Branding / DISTRIBUTION** — `distribution.mjs`, the `bharatcode` bin shim,
   `build.ts`, package identity.
4. **Channel-scoped storage paths** — `StoragePaths`, and one data directory
   named for the product.
5. **Auth** — the transactional credential store, SQLite lock, Windows store.
6. **bharatcode-core** — account, catalog, model eligibility, OAuth loopback.
7. **Import engine** — replayed, and taken **off the startup path**.
8. **Provider layer** — the BharatCode catalog, product policy, and the DeepSeek
   reasoning fix from #57.
9. **Goal Mode backend** — schema, migration, state machine, tools, command.

## What is left

Ordered by dependency, not by size.

| Theme | Scope (our delta since the fork) | Notes |
|---|---|---|
| **cli-core** | `src/cli` 28 files +1,035; `src/session` 13 files +877; `src/server` 28 files +581 | `prompt.ts` is the hard one: 220 ours over a 667-line upstream rewrite. Unblocks the Goal Mode HTTP handler. |
| **desktop-shell** | 338 files, +27,680 | The single largest body of work, but only ~12% contested. |
| **app-ui** | `packages/app` 86 files +4,112; `packages/ui` 81 files +324 | Includes re-homing the Goal Mode ribbon. |
| **ci-release** | `.github` 48 files, +8,471 | Re-author from the current workflows, not commit by commit. |
| **tests** | 75 files, +12,448 | Prune while replaying. |
| **sdk + lockfile** | generated | Regenerate last, after Goal Mode and bharatcode-core are in. |

### Known follow-ups

- **Goal Mode is not wired end-to-end.** The API accepts a goal payload but
  nothing routes it. Needs the `ensureGoal*` methods in `prompt.ts` (cli-core)
  and the HTTP handler. The ribbon needs `packages/app` and a regenerated SDK.
- **The Goal Mode ribbon still needs re-homing** onto upstream's
  `session-composer-region-controller.ts`. Doing it before `packages/app` is
  reconciled means doing it twice.
- **One test is skipped with a reason** — `provider-policy.test.ts` scans httpapi
  v2 handler sources that are not on the branch yet.
- **`toV2Provider` has a semantic gap.** The old provider carried
  `enabled: { via: "account" }`; the new `ProviderV2.Info` has no equivalent and
  upstream gates on `request.body.apiKey` or an integration. Decide with the v2
  handlers.
- **`lean-migration-recovery.test.ts`**, when replayed, should resolve paths
  through `StoragePaths.resolve` rather than re-introducing its own
  `canonicalLayout()`, which now duplicates it.
- The two shell/review-pane UI bugs are **dropped, not ported** — upstream
  already fixed both, better than the one-line tweaks we had planned.

## Things worth knowing before continuing

### "0% overlap" never meant "replays clean"

The inventory ranked themes by file overlap. That ranking was wrong twice, and
both times the code compiled or typechecked before failing:

- **bharatcode-core** (0% overlap) did not build. It needs our `auth`, which
  needs `Global.auth`, which needs `StoragePaths` — a theme the plan had placed
  two steps *later*. The dependency graph, not the overlap percentage, decides
  the order.
- **Goal Mode** (0% overlap) built fine and silently did nothing. Sessions are
  event-sourced now: `Session.patch` publishes `SessionV1.Event.Updated` and a
  projector in `core` writes the row. A new session field has to exist in the
  schema the *event* carries and be mapped by the projector, or it is dropped on
  write. Sessions created, `setGoal` reported success, every read came back
  `undefined`.

### Typecheck is not verification

Three separate times a green `turbo typecheck` hid a broken suite:

- stale `AppFileSystem` imports in test files and worker fixtures — five tests
  hung on 15-second readiness barriers because a spawned fixture was missing.
- the product policy defaulting to shipped — **189 upstream tests** failed
  (103 provider, 86 session/agent) while typecheck stayed green.
- `global.test.ts` asserting the tmp directory was literally `"opencode"`,
  missed because I ran only the storage-paths test rather than the core suite.

**Run the affected suites after every theme, including upstream's own**, and
take a baseline before a change that could plausibly break them.

### Prefer the mechanism that removes churn

The product policy first resolved to the shipped layer, on the reasoning that
the restrictive default is the safe one. It is — but it made every generic
composition wrong by default, and fixing it meant threading a policy layer
through ten test files and redoing that at each future sync. Deriving it from
`InstallationChannel` instead gives the same guarantee with no churn: a packaged
beta/prod build is shipped, a local or test build is internal, and a packaged
build cannot forget to opt in.

### Use upstream's tooling, not our replayed copy of it

The Goal Mode column went in through `bun run migration --name add_goal_mode`,
which produced the migration module, the registry, the generated schema and the
snapshot. Our fork's hand-written `packages/opencode/migration/*.sql` is not
replayed — upstream moved that lineage into programmatic modules. Same for
`serviceUse`, which moved into `core` and gained a memo cache: we dropped our
copy rather than replaying it.

## Upstream API drift

The same changes recur in every theme:

| Was (fork point) | Is now |
|---|---|
| `AppFileSystem` (`core/filesystem`) | `FSUtil` (`core/fs-util`) — old export **gone** |
| `Schema.Defect` | `Schema.Defect()` |
| `Schema.Class` for `ProviderV2.Info` / `ModelV2.Info` | `Schema.Struct` — `new X({...})` → `X.make({...})` |
| `export const layer` / `defaultLayer` | `export const node = LayerNode.make(...)`; compile with `LayerNode.compile(node)` |
| `core/util/log`, `Log.Default.warn` | `Effect.logWarning(msg, {...})` |
| `@/effect/service-use` | `@opencode-ai/core/effect/service-use` |
| `@/provider/schema` (`ProviderID`, `ModelID`) | `ProviderV2.ID`, `ModelV2.ID` |
| `MessageV2.WithParts` / `TextPart` / `Assistant` / `User` | `SessionV1.*` from `core/v1/session` |

`FSUtil` exposes only `node` — there is no `FSUtil.defaultLayer`. Tests that
provided `AppFileSystem.defaultLayer` need `LayerNode.compile(FSUtil.node)`.

## Environment

Fetching `upstream` fails under git protocol v2 with
`curl 56 ... bad record mac`. It is the negotiation, not the packfile. Pinned in
`.git/config`:

```
git config --local protocol.version 0
```

Even then `git fetch upstream --prune` (all refs) fails; fetch a single branch:
`git fetch upstream dev --no-tags`. Without `--filter` that also pulls blobs,
which makes the checkout instant despite the `blob:none` partial clone.

**Do not probe with `--depth=1`** — it writes `.git/shallow` and silently
shallow-ifies the repo. Recover by deleting that file; all objects are local.

## PR 47

Closed and stray: it targeted `fix/startup-migration-gate`, which was later
deleted, so it was closed with its work apparently stranded. Both its commits
are non-ancestors of `dev`, but the resulting files are **byte-identical to
`dev`** — the work was re-landed by another route. Nothing is lost; only the
orphan branch `fix/test-macos-paths` remains.
