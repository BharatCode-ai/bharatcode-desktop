# BharatCode Lean Migration/Recovery Tasks 6–7 Result

## Identity

```json
{
  "acceptedProductCoreHead": "6bc62788a1a5eff75b8282fe11b271a7c0b76a32",
  "acceptedProductCoreImplementation": "3599b5239ae76be88e9daf9f9ddc93b0d935fd18",
  "acceptedMigrationTasks1To5": "9a0523e91e76bd82ab123d67fc753ae82c7d85d3",
  "rebasedMigrationTasks1To5": "f9c2af953a5ebd628f90aaf45bdbbceb864290c7",
  "acceptedCompatibilitySource": "da8d2db8389e89a7c9e5021f294bebd52a322bfd",
  "localCompatibilityCommit": "9f8526a73221917fe675875df4d3aebe8ea65416",
  "task6Head": "2bb1a31f9d548a295c99d3aeafc594ca18d9da0a",
  "task7Head": "c90e54aff89d17cf91d8ec781a8be7bb483aaca6",
  "correctionCommitParent": "c90e54aff89d17cf91d8ec781a8be7bb483aaca6",
  "scenarios": {
    "6": "PASS_LOCAL",
    "7": "PASS_LOCAL"
  },
  "findings": {
    "BETA_BLOCKER": [],
    "POST_BETA_HARDENING": [],
    "EXTERNAL_EVIDENCE": [
      "Release-owned packaged-host proof that Desktop invokes the bundled exact BharatCode CLI on each shipped OS remains outside this local lane.",
      "Native Windows ACL and packaged Desktop execution remain Release/Windows-host evidence; local Node-target compilation and execution do not claim that host result."
    ]
  }
}
```

The correction commit cannot contain its own Git object ID.
`correctionCommitParent` therefore identifies the exact reviewed Task 7 parent;
the final correction SHA is returned alongside this report.

## Executed scenario receipts

The dedicated acceptance test emitted this receipt only after its assertions
completed:

```json
{
  "type": "lean-migration-recovery-receipt",
  "receipts": [
    {
      "scenario": 6,
      "proof": "explicit-sanitized-preserved-restart",
      "assertions": 13
    },
    {
      "scenario": 6,
      "proof": "stale-choice-and-ambiguity",
      "assertions": 6
    },
    {
      "scenario": 7,
      "proof": "post-database-switch-retry-and-mutation-rejection",
      "assertions": 4
    },
    {
      "scenario": 7,
      "proof": "marker-independent-fresh-compatible-repair-incompatible-refusal",
      "assertions": 13
    },
    {
      "scenario": 7,
      "proof": "real-cli-desktop-runtime-boundary-convergence",
      "assertions": 15
    }
  ]
}
```

These receipts came from real temporary fixture directories and SQLite files.
They prove:

- explicit opaque source selection and deterministic ambiguity;
- stale-choice/source-mutation rejection before destination effects;
- source byte preservation and retained session/config continuity, including
  legacy global `opencode.json[c]` publication as canonical
  `bharatcode.json[c]` with collision refusal;
- removal of active provider, URL, command, account, and permission state while
  retaining harmless transcript text;
- restart to the same ready state;
- Retry after the canonical database durable-switch edge and exact mutation
  rejection at that edge;
- marker-independent Start Fresh with an unreadable invalid marker;
- compatible marker-only repair, plus corrupt and incompatible refusal without
  database mutation;
- concurrent real CLI/Desktop adapter use across separate processes converging
  under the same maintenance lock;
- actual BharatCode `debug config` loading the migrated canonical configuration
  from the migrated home; and
- the accepted Product Core vertical worker running against that same migrated
  home while instrumenting real fetch, connect, spawn, schema, provider, and
  authorization boundaries. Its executed receipt contained no forbidden or
  ShareNext attempts and reported a closed boundary.

The capture and SQLite assertions remain static sanitation evidence. They are
not presented as executed network/process evidence. The vertical worker is
local source-runtime evidence; this report does not claim packaged or native
host execution.

## Final-byte verification

All temporary files were placed under the lane-owned
`/tmp/codex-lean-migration-recovery` root, which was deleted and recreated
before the disk-heavy final matrix.

From `packages/opencode`:

```bash
TMPDIR=/tmp/codex-lean-migration-recovery bun test \
  test/product/lean-migration-recovery.test.ts \
  test/migration \
  test/storage/schema-marker.test.ts \
  test/cli/doctor.test.ts
bun typecheck
```

Result: **61 passed, 0 failed, 281 assertions; typecheck exit 0**.

From `packages/desktop`:

```bash
TMPDIR=/tmp/codex-lean-migration-recovery bun test \
  src/main/startup-recovery.test.ts \
  src/renderer/loading-recovery.test.ts
bun typecheck
```

Result: **9 passed, 0 failed, 34 assertions; typecheck exit 0**. The complete
Desktop suite also passed **57 tests, 0 failures, 201 assertions**.

The exact compatibility command that previously exposed 29 failures was rerun
after the accepted test-only compatibility checkpoint:

```bash
TMPDIR=/tmp/codex-lean-migration-recovery bun test \
  test/migration/source.test.ts \
  test/migration/sanitize.test.ts \
  test/migration/capture.test.ts \
  test/migration/journal.test.ts \
  test/migration/cutover.test.ts \
  test/storage/schema-marker.test.ts \
  test/storage/json-migration.test.ts \
  test/storage/db.test.ts \
  test/config/tui.test.ts
```

Result: **108 passed, 3 Windows-only skips, 0 failed, 402 assertions**. The
29-failure compatibility debt is closed by the accepted two-test-file
checkpoint; no Product Core source changed for that correction.

Product Core distribution and metadata-path acceptance was rerun from
`packages/opencode`:

```bash
TMPDIR=/tmp/codex-lean-migration-recovery bun test \
  test/distribution/lean-package.test.ts \
  test/cli/doctor.test.ts
```

Result: **7 passed, 0 failed, 66 assertions**. This includes an actual local
package/install probe plus fresh-home `--help` and `--version` processes that
created neither a canonical database nor a schema marker. Command help remains
available, while ordinary `db path` and the post-separator payload forms
`db path -- --help` and `run -- --version` remain recovery-blocked without
creating either artifact.

The shared Node/Desktop runtime boundary was also built and executed:

```bash
bun script/build-node.ts
mkdir -p /tmp/codex-lean-migration-recovery/node-smoke/.local/share/bharatcode-test
OPENCODE_TEST_HOME=/tmp/codex-lean-migration-recovery/node-smoke \
  BHARATCODE_CHANNEL=test \
  node --input-type=module -e \
  'const { Database } = await import("./dist/node/node.js"); Database.Client(); Database.close()'
```

Result: build exit 0; the Node runtime created a canonical database and exact
`20260630000000_add_goal_mode` schema marker. This is local Node evidence, not a
claim of native Windows packaging.

## Requirement delta and integration seams

- Desktop does not import Bun SQLite or migration internals. Electron main
  invokes only fixed closed subcommands of the packaged exact BharatCode CLI;
  renderer/preload IPC carries IDs, labels, fingerprints, operation IDs,
  statuses, and explicit confirmations only.
- Startup blocks before account-client creation and sidecar spawn until the
  shared recovery controller returns `ready`.
- `bharatcode doctor` is read-only. `bharatcode doctor repair --confirm` is the
  only marker repair path and does not rewrite database contents.
- Help and version metadata tokens bypass recovery inspection only before the
  first literal `--`, without creating the canonical database or schema marker;
  ordinary and post-separator stateful forms remain recovery-gated.
- Desktop interrupted recovery exposes both Retry and marker-independent Start
  Fresh through a closed action helper, with every rendered action disabled
  while another action is in flight.
- The database client validates a compatible marker before opening an existing
  canonical database, applies released migrations only after that gate, and
  publishes/revalidates the exact resulting marker before returning the client.
- Two narrow Task 6/7 interface corrections were required beyond the nominal
  file list: the schema-candidate helper accepts Drizzle's exact metadata-table
  bootstrap, and the storage maintenance lock uses a Bun/Node-selected SQLite
  adapter so the accepted Desktop Node sidecar remains executable. Task 7 also
  corrected unreadable owned-partial hashing so Start Fresh can quarantine the
  same revalidated inode without depending on marker readability.
- ShareNext remains disabled. No WSL, Release, Apple, Platform, workflow,
  publication, deployment, or coordinator-ledger file was changed.

## External holds

No local `BETA_BLOCKER` remains for scenarios 6–7. Cohort-wide beta acceptance
still depends on coordinator-owned integration and the separately owned WSL,
Release, native-host, signing/notarization, package, and publication evidence.
