import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { Database } from "bun:sqlite"

import * as acceptance from "./lean-upgrade-acceptance.mjs"
import {
  parseUpgradeAcceptanceArguments,
  acceptanceFailureCode,
  consumeGithubActionsToken,
  githubApiHeaders,
  initializePinnedBetaSchema,
  runLeanUpgradeAcceptance,
  validateCurrentBetaApiObservation,
  validateUpgradeExecutionObservation,
  verifyPinnedInstaller,
} from "./lean-upgrade-acceptance.mjs"
import { canonicalLeanJson, parseCurrentBetaFixtureBytes } from "./lean-upgrade-receipt.mjs"

const sourceSha = "3b09dcff0d7e8ad7487c6d40199b704ed0712005"
const fixturePath = resolve(import.meta.dir, "../test/fixtures/current-beta-windows-x64.json")
const candidate = {
  key: "desktop-windows-x64",
  filename: "bharatcode-desktop-next-beta-win-x64.exe",
  bytes: 120_000_000,
  sha256: "a".repeat(64),
}
const session = { id: "ses_upgrade_acceptance", title: "Preserved packaged beta session" }

function pe() {
  return Buffer.concat([Buffer.from("MZ"), Buffer.alloc(16), Buffer.from("PE\0\0"), Buffer.alloc(16)])
}

async function currentBeta() {
  return parseCurrentBetaFixtureBytes(new Uint8Array(await Bun.file(fixturePath).arrayBuffer()))
}

function checks() {
  return {
    current_beta_download_verified: true,
    current_beta_installed: true,
    eligible_state_seeded: true,
    candidate_installed_over_beta: true,
    eligible_state_preserved: true,
    candidate_started: true,
    bharatcode_runtime_only: true,
    rollback_installed: true,
    rollback_state_structurally_valid: true,
    migration_source_preserved: true,
    recovery_evidence_preserved: true,
    sharenext_absent: true,
    share_network_attempt_absent: true,
  }
}

function observation() {
  return {
    schema: "bharatcode-packaged-upgrade-observation-v1",
    candidate: { ...candidate },
    checks: checks(),
    cleanup_complete: true,
  }
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "lean-upgrade-acceptance-"))
  const acceptanceDirectory = join(root, "acceptance")
  const localFixture = join(root, "current-beta.json")
  const candidatePath = join(root, candidate.filename)
  await writeFile(localFixture, canonicalLeanJson(await currentBeta()))
  await writeFile(candidatePath, "candidate")
  const argv = [
    "--fixture",
    localFixture,
    "--candidate",
    candidatePath,
    "--source-sha",
    sourceSha,
    "--acceptance-dir",
    acceptanceDirectory,
  ]
  const dependencies = {
    platform: "win32",
    arch: "x64",
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "github-actions-fixture-token",
      GITHUB_RUN_ID: "123456789",
      GITHUB_RUN_ATTEMPT: "2",
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      RUNNER_ENVIRONMENT: "github-hosted",
      ImageOS: "win25",
      ImageVersion: "20260713.1.0",
    },
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    execute: async () => observation(),
    ...overrides,
  }
  return { root, acceptanceDirectory, localFixture, candidatePath, argv, dependencies }
}

describe("real packaged Windows upgrade and rollback acceptance", () => {
  test("accepts only the exact closed CLI and immutable candidate filename", async () => {
    const input = await fixture()
    try {
      expect(parseUpgradeAcceptanceArguments(input.argv)).toEqual({
        fixture: input.localFixture,
        candidate: input.candidatePath,
        sourceSha,
        acceptanceDirectory: input.acceptanceDirectory,
      })
      for (const hostile of [
        input.argv.slice(0, -2),
        [...input.argv, "--extra", "value"],
        input.argv.map((value) => (value === sourceSha ? "0".repeat(40) : value)),
        input.argv.map((value) => (value === input.candidatePath ? join(input.root, "candidate.exe") : value)),
      ]) {
        expect(() => parseUpgradeAcceptanceArguments(hostile)).toThrow()
      }
    } finally {
      await rm(input.root, { recursive: true, force: true })
    }
  })

  test("discovers exactly BharatCode Beta.exe and closes the owned utility process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "lean-upgrade-installed-"))
    const executable = join(root, "BharatCode Beta.exe")
    try {
      await writeFile(executable, pe())
      await writeFile(join(root, "Uninstall BharatCode Beta.exe"), pe())
      expect(await acceptance.discoverPackagedApplication(root)).toEqual({ executable })

      const records = [
        {
          process_id: 4100,
          parent_process_id: 1,
          executable_path: executable,
          command_line: `"${executable}" --disable-gpu`,
        },
        {
          process_id: 4101,
          parent_process_id: 4100,
          executable_path: executable,
          command_line: `"${executable}" --type=utility --utility-sub-type=node.mojom.NodeService`,
        },
      ]
      expect(acceptance.validateOwnedProcessTree(records, { rootPid: 4100, executable })).toEqual({
        rootPid: 4100,
        utilityPid: 4101,
        pids: [4100, 4101],
      })
      expect(acceptance.validateOwnedProcessesGone([4100, 4101], [])).toBeTrue()
      expect(() => acceptance.validateOwnedProcessesGone([4100, 4101], [records[1]])).toThrow()
      expect(() => acceptance.validateOwnedProcessTree(records.slice(0, 1), { rootPid: 4100, executable })).toThrow()
      expect(() =>
        acceptance.validateOwnedProcessTree(
          [records[0], { ...records[1], executable_path: join(root, "substituted.exe") }],
          { rootPid: 4100, executable },
        ),
      ).toThrow()

      await rm(executable)
      await expect(acceptance.discoverPackagedApplication(root)).rejects.toThrow(/missing|exactly one/i)
      await writeFile(executable, pe())
      await writeFile(join(root, "Another.exe"), pe())
      await expect(acceptance.discoverPackagedApplication(root)).rejects.toThrow(/ambiguous|exactly one/i)

      const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
      expect(source).not.toContain('const INSTALLED_EXECUTABLE = "bharatcode-beta.exe"')
      const branding = await readFile(new URL("../src/main/branding.ts", import.meta.url), "utf8")
      expect(branding).toContain('appName: "BharatCode"')
      expect(branding).toContain("return `${BRANDING.appName} ${channel.charAt(0).toUpperCase() + channel.slice(1)}`")
      expect(await readFile(new URL("../electron-builder.config.ts", import.meta.url), "utf8")).toContain(
        "productName: productNameForChannel(channel)",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("recognizes only the shipped post-initialization log and rejects premature or failed startup", () => {
    const prior = "[info] init step { step: { phase: 'done' } }\r\n"
    const healthy =
      "[info] sidecar connection started { url: 'http://127.0.0.1:43123' }\r\n" + `[2026-07-20 10:00:00.000] ${prior}`
    expect(acceptance.parsePackagedReadinessLog(healthy)).toBeTrue()
    expect(() => acceptance.parsePackagedReadinessDelta(prior, `${prior}[info] app starting\r\n`)).toThrow()
    expect(acceptance.parsePackagedReadinessDelta(prior, `${prior}${healthy}`)).toBeTrue()
    expect(() => acceptance.parsePackagedReadinessDelta(prior, `[info] truncated\r\n${healthy}`)).toThrow()
    for (const hostile of [
      "[info] app starting { version: '1.2.3', packaged: true }\r\n",
      '[info] init step { step: { phase: "server_waiting" } }\r\n',
      "[info] init step { step: { phase: done } }\r\n",
      "[error] sidecar exited before ready\r\n",
      `[error] sidecar health check failed Error: unavailable\r\n${healthy}`,
      `[error] utility process error: spawn failed\r\n${healthy}`,
      `[error] utility process gone reason=crashed\r\n${healthy}`,
      `[error] sidecar exited { code: 1 }\r\n${healthy}`,
      `[error] child process gone { reason: 'crashed' }\r\n${healthy}`,
    ]) {
      expect(() => acceptance.parsePackagedReadinessLog(hostile)).toThrow()
    }

    const executable = "C:\\Program Files\\BharatCode Beta\\BharatCode Beta.exe"
    const records = [
      {
        process_id: 4100,
        parent_process_id: 1,
        executable_path: executable,
        command_line: `"${executable}" --remote-debugging-port=43124`,
      },
      {
        process_id: 4101,
        parent_process_id: 4100,
        executable_path: executable,
        command_line: `"${executable}" --type=utility --utility-sub-type=node.mojom.NodeService`,
      },
    ]
    expect(
      acceptance.validatePackagedReadinessObservation(
        { log_delta: healthy, processes: records },
        { rootPid: 4100, executable },
      ),
    ).toEqual({ rootPid: 4100, utilityPid: 4101, pids: [4100, 4101], sidecarOrigin: "http://127.0.0.1:43123" })
    expect(() =>
      acceptance.validatePackagedReadinessObservation(
        { log_delta: healthy, processes: records.slice(0, 1) },
        { rootPid: 4100, executable },
      ),
    ).toThrow(/utility|sidecar/i)
  })

  test("accepts only the exact legacy OpenCode recovery source and observation-derived preserved state", () => {
    const recovery = {
      state: "choose-source",
      sources: [
        {
          id: `opencode-cli-${"a".repeat(64)}`,
          label: "Existing BharatCode data · opencode-cli · aaaaaaaa",
          contentFingerprint: "b".repeat(64),
        },
      ],
    }
    expect(acceptance.selectLegacyRecoverySource(recovery)).toEqual({
      id: recovery.sources[0].id,
      contentFingerprint: recovery.sources[0].contentFingerprint,
    })
    for (const hostile of [
      { state: "start-fresh", reason: "no-source" },
      { ...recovery, sources: [] },
      { ...recovery, sources: [...recovery.sources, recovery.sources[0]] },
      { ...recovery, sources: [{ ...recovery.sources[0], label: "Existing BharatCode data · opencode-desktop" }] },
    ]) {
      expect(() => acceptance.selectLegacyRecoverySource(hostile)).toThrow()
    }

    const evidence = {
      schema: "bharatcode-packaged-state-evidence-v1",
      source: {
        database_before_sha256: "1".repeat(64),
        database_after_sha256: "1".repeat(64),
        config_before_sha256: "2".repeat(64),
        config_after_sha256: "2".repeat(64),
      },
      recovery: {
        selected_source_id: recovery.sources[0].id,
        selected_content_fingerprint: recovery.sources[0].contentFingerprint,
        actions: ["choose-source"],
        final_state: "ready",
        journal_sha256: "3".repeat(64),
        snapshot_verified: true,
        sentinels_absent: true,
      },
      candidate: {
        database_quick_check: "ok",
        session,
        config: { snapshot: false },
        account_state: "signed-out",
        credential_store_usable: false,
        sentinel_present: false,
      },
      rollback: {
        database_quick_check: "ok",
        session,
        config: { snapshot: false },
        legacy_account_intact: true,
      },
    }
    expect(acceptance.validateStateEvidence(evidence, session)).toEqual({
      eligibleStatePreserved: true,
      migrationSourcePreserved: true,
      recoveryEvidencePreserved: true,
      rollbackStateStructurallyValid: true,
    })
    for (const hostile of [
      { ...evidence, source: { ...evidence.source, database_after_sha256: "3".repeat(64) } },
      { ...evidence, recovery: { ...evidence.recovery, actions: ["start-fresh"] } },
      { ...evidence, recovery: { ...evidence.recovery, snapshot_verified: false } },
      { ...evidence, recovery: { ...evidence.recovery, sentinels_absent: false } },
      { ...evidence, recovery: { ...evidence.recovery, journal_sha256: "invalid" } },
      { ...evidence, candidate: { ...evidence.candidate, session: undefined } },
      { ...evidence, candidate: { ...evidence.candidate, credential_store_usable: true } },
      { ...evidence, candidate: { ...evidence.candidate, sentinel_present: true } },
      { ...evidence, rollback: { ...evidence.rollback, database_quick_check: "corrupt" } },
      { ...evidence, rollback: { ...evidence.rollback, legacy_account_intact: false } },
    ]) {
      expect(() => acceptance.validateStateEvidence(hostile, session)).toThrow()
    }

    const sentinels = ["bharatcode-cp3-inert-access-sentinel", "bharatcode-cp3-inert-refresh-sentinel"]
    expect(acceptance.observeCredentialStoreUsability([Buffer.from("{}"), Buffer.from(" \r\n")], sentinels)).toBeFalse()
    expect(
      acceptance.observeCredentialStoreUsability(
        [Buffer.from(JSON.stringify({ bharatcode: { access: "candidate-credential" } }))],
        sentinels,
      ),
    ).toBeTrue()
    expect(() => acceptance.observeCredentialStoreUsability([Buffer.from("not-json")], sentinels)).toThrow()
    expect(acceptance.observeCredentialSentinelPresence([Buffer.from("safe snapshot")], sentinels)).toBeFalse()
    expect(
      acceptance.observeCredentialSentinelPresence([Buffer.from(`snapshot:${sentinels[0]}`)], sentinels),
    ).toBeTrue()
    expect(
      acceptance.observeCredentialSentinelPresence([Buffer.from(`snapshot:${sentinels[1]}`)], sentinels),
    ).toBeTrue()
  })

  test("seeds the inert account against the exact pinned current-beta account schema", async () => {
    const accountSource = await readFile(new URL("../../opencode/src/account/account.sql.ts", import.meta.url), "utf8")
    const accountTable = accountSource.slice(
      accountSource.indexOf("export const AccountTable"),
      accountSource.indexOf("export const AccountStateTable"),
    )
    expect(accountTable).not.toContain("selected_org_id")
    expect(accountSource).toContain("active_org_id: text().$type<OrgID>()")

    const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
    expect(source).not.toContain("selected_org_id")
    expect(source).toContain("active_account_id, active_org_id")

    const database = new Database(":memory:")
    try {
      database.run(
        "CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL)",
      )
      database.run(
        "CREATE TABLE account_state (id integer PRIMARY KEY NOT NULL, active_account_id text, active_org_id text)",
      )
      acceptance.seedLegacyAccount(database)
      expect(acceptance.legacyAccountIntact(database)).toBeTrue()
      expect(database.query("SELECT id, active_account_id, active_org_id FROM account_state").get()).toEqual({
        id: 1,
        active_account_id: "acc_upgrade_acceptance",
        active_org_id: null,
      })
      database.query("UPDATE account_state SET active_org_id = 'org_hostile'").run()
      expect(acceptance.legacyAccountIntact(database)).toBeFalse()
      database.query("UPDATE account_state SET active_org_id = NULL").run()
      database.query("UPDATE account SET access_token = 'substituted'").run()
      expect(acceptance.legacyAccountIntact(database)).toBeFalse()
    } finally {
      database.close()
    }
  })

  test("materializes the exact pinned beta migration schema without starting the old Desktop", async () => {
    const root = resolve(import.meta.dir, "../../opencode/migration")
    const names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name <= "20260630000000_add_goal_mode")
      .map((entry) => entry.name)
      .sort()
    const migrations = await Promise.all(
      names.map(async (name) => ({ name, sql: await readFile(join(root, name, "migration.sql"), "utf8") })),
    )
    const database = new Database(":memory:")
    try {
      expect(initializePinnedBetaSchema(database, migrations)).toBe(true)
      expect(database.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" })
      expect(
        database
          .query("PRAGMA table_info(project)")
          .all()
          .some((column) => column.name === "commands"),
      ).toBe(true)
      expect(
        database
          .query("PRAGMA table_info(account_state)")
          .all()
          .some((column) => column.name === "active_org_id"),
      ).toBe(true)
    } finally {
      database.close()
    }
  })

  test("creates the nested pinned beta database path before materializing migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "bharatcode-pinned-beta-"))
    const path = join(root, "xdg", "data", "opencode", "opencode.db")
    try {
      await acceptance.initializePinnedBetaDatabase(path)
      const database = new Database(path, { readonly: true })
      try {
        expect(database.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" })
        expect(
          database
            .query("PRAGMA table_info(session)")
            .all()
            .some((column) => column.name === "goal"),
        ).toBe(true)
      } finally {
        database.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("requires executed share/unshare refusal and complete nonempty network captures", () => {
    const event = {
      source: { id: 1, start_time: "1" },
      type: 1,
      phase: 0,
      time: "2",
      params: { url: "https://bharatcode.ai/api/model/v1/models" },
    }
    expect(
      acceptance.validatePackagedNetLogBytes(
        Buffer.from(JSON.stringify({ constants: { logEventTypes: {} }, events: [event] })),
      ),
    ).toBeTrue()
    for (const hostile of [
      Buffer.alloc(0),
      Buffer.from("{"),
      Buffer.from("{}"),
      Buffer.from(JSON.stringify({ constants: {}, events: [] })),
      Buffer.from(
        JSON.stringify({ constants: {}, events: [{ ...event, params: { url: "https://bharatcode.ai/api/share" } }] }),
      ),
    ]) {
      expect(() => acceptance.validatePackagedNetLogBytes(hostile)).toThrow()
    }

    const sidecarOrigin = "http://127.0.0.1:43123"
    const response = {
      status: 500,
      content_type: "application/json",
      body: '{"_tag":"InternalServerError"}',
      url: `${sidecarOrigin}/session/${session.id}/share`,
      redirected: false,
    }
    const observation = {
      schema: "bharatcode-live-electron-share-observation-v1",
      renderer_origin: "oc://renderer",
      sidecar_origin: sidecarOrigin,
      target_id: "renderer-page",
      root_pid: 4100,
      utility_pid: 4101,
      before_pids: [4100, 4101],
      after_pids: [4100, 4101],
      unauthenticated_control: {
        status: 401,
        content_type: null,
        body: "",
        url: `${sidecarOrigin}/session/${session.id}/share`,
        redirected: false,
        www_authenticate: 'Basic realm="Secure Area"',
      },
      post: response,
      delete: response,
      audit_requests: 0,
    }
    expect(acceptance.validateShareSurfaceObservation(observation)).toEqual({
      sharenextAbsent: true,
      shareNetworkAttemptAbsent: true,
    })
    for (const hostile of [
      { help_only: true },
      { ...observation, renderer_origin: "https://hostile.example" },
      { ...observation, unauthenticated_control: { ...observation.unauthenticated_control, status: 500 } },
      {
        ...observation,
        unauthenticated_control: { ...observation.unauthenticated_control, www_authenticate: null },
      },
      { ...observation, post: { ...response, status: 200 } },
      { ...observation, post: { ...response, status: 401 } },
      { ...observation, delete: { ...response, status: 401 } },
      { ...observation, post: { ...response, redirected: true } },
      { ...observation, audit_requests: 1 },
      { ...observation, after_pids: [4100] },
      { ...observation, utility_pid: 4199 },
    ]) {
      expect(() => acceptance.validateShareSurfaceObservation(hostile)).toThrow()
    }

    const target = {
      id: "renderer-page",
      type: "page",
      url: "oc://renderer/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:43124/devtools/page/renderer-page",
    }
    expect(acceptance.selectRendererCdpTarget([target], 43124)).toEqual(target)
    for (const hostile of [
      [],
      [target, { ...target, id: "duplicate", webSocketDebuggerUrl: "ws://127.0.0.1:43124/devtools/page/duplicate" }],
      [{ ...target, url: "https://hostile.example" }],
      [{ ...target, webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/renderer-page" }],
    ]) {
      expect(() => acceptance.selectRendererCdpTarget(hostile, 43124)).toThrow()
    }

    const cdp = { id: 7, result: { result: { type: "object", value: observation } } }
    expect(acceptance.parseRendererShareEvaluation(cdp, 7)).toEqual(observation)
    for (const hostile of [
      { ...cdp, id: 8 },
      { id: 7, result: { exceptionDetails: { text: "fetch failed" } } },
      { id: 7, error: { message: "CDP disconnected" } },
    ]) {
      expect(() => acceptance.parseRendererShareEvaluation(hostile, 7)).toThrow()
    }

    const listeners = [
      { local_address: "127.0.0.1", local_port: 43124, state: "Listen", owning_process: 4100 },
      { local_address: "127.0.0.1", local_port: 43123, state: "Listen", owning_process: 4101 },
    ]
    expect(acceptance.validateLoopbackListenerOwner(listeners, { port: 43124, pid: 4100 })).toBeTrue()
    expect(acceptance.validateLoopbackListenerOwner(listeners, { port: 43123, pid: 4101 })).toBeTrue()
    for (const [hostile, expected] of [
      [
        listeners.map((item) => (item.local_port === 43124 ? { ...item, owning_process: 4999 } : item)),
        { port: 43124, pid: 4100 },
      ],
      [listeners.filter((item) => item.local_port !== 43123), { port: 43123, pid: 4101 }],
      [[...listeners, listeners[0]], { port: 43124, pid: 4100 }],
      [
        listeners.map((item) => (item.local_port === 43124 ? { ...item, local_address: "0.0.0.0" } : item)),
        { port: 43124, pid: 4100 },
      ],
    ]) {
      expect(() => acceptance.validateLoopbackListenerOwner(hostile, expected)).toThrow()
    }
  })

  test("accepts only the exact optional Chromium private-network preflight contract", async () => {
    const controlUrl = "http://10.20.30.40:43125/bharatcode-firewall-control/11111111-1111-4111-8111-111111111111"
    const harness = acceptance.routeEgressControlRequest(new Request(controlUrl), controlUrl)
    expect(harness.kind).toBe("harness-get")
    expect(harness.response.status).toBe(204)
    expect(Object.fromEntries(harness.response.headers)).toEqual({
      "cache-control": "no-store",
      connection: "close",
      "x-bharatcode-egress-control": "active",
    })
    expect(await harness.response.text()).toBe("")

    const preflight = acceptance.routeEgressControlRequest(
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "oc://renderer",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      controlUrl,
    )
    expect(preflight.kind).toBe("renderer-preflight")
    expect(preflight.response.status).toBe(204)
    expect(Object.fromEntries(preflight.response.headers)).toEqual({
      "access-control-allow-methods": "GET",
      "access-control-allow-origin": "oc://renderer",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "0",
      "cache-control": "no-store",
      connection: "close",
    })
    expect(await preflight.response.text()).toBe("")

    const renderer = acceptance.routeEgressControlRequest(
      new Request(controlUrl, { headers: { Origin: "oc://renderer" } }),
      controlUrl,
    )
    expect(renderer.kind).toBe("renderer-get")
    expect(renderer.response.status).toBe(204)
    expect(Object.fromEntries(renderer.response.headers)).toEqual({
      "access-control-expose-headers": "Cache-Control, Connection, X-BharatCode-Egress-Control",
      "access-control-allow-origin": "oc://renderer",
      "cache-control": "no-store",
      connection: "close",
      "x-bharatcode-egress-control": "active",
    })
    expect(await renderer.response.text()).toBe("")

    for (const hostile of [
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "https://hostile.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: { Origin: "oc://renderer", "Access-Control-Request-Method": "GET" },
      }),
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "oc://renderer",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "false",
        },
      }),
      new Request(controlUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "oc://renderer",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      new Request(controlUrl, { headers: { Origin: "https://hostile.example" } }),
      new Request(controlUrl, { method: "POST", headers: { Origin: "oc://renderer" } }),
      new Request(`${controlUrl}/foreign`, { headers: { Origin: "oc://renderer" } }),
    ]) {
      expect(() => acceptance.routeEgressControlRequest(hostile, controlUrl)).toThrow()
    }
  })

  test("constructs one candidate-only Chromium 146 endpoint address-space override", async () => {
    const controlUrl = "http://10.20.30.40:43125/bharatcode-firewall-control/11111111-1111-4111-8111-111111111111"
    expect(acceptance.candidateAddressSpaceOverrideArguments("candidate", controlUrl)).toEqual([
      "--ip-address-space-overrides=10.20.30.40:43125=public",
    ])
    expect(acceptance.candidateAddressSpaceOverrideArguments("current-beta")).toEqual([])
    expect(acceptance.candidateAddressSpaceOverrideArguments("rollback")).toEqual([])
    const override = acceptance.candidateAddressSpaceOverrideArguments("candidate", controlUrl)
    const executable = "C:\\Program Files\\BharatCode Beta\\BharatCode Beta.exe"
    const records = [
      {
        process_id: 4100,
        parent_process_id: 1,
        executable_path: executable,
        command_line: `"${executable}" ${override[0]} --no-proxy-server "C:\\Acceptance Files\\--proxy-server=data.txt"`,
      },
      {
        process_id: 4101,
        parent_process_id: 4100,
        executable_path: executable,
        command_line: `"${executable}" --type=utility --utility-sub-type=node.mojom.NodeService`,
      },
      {
        process_id: 4102,
        parent_process_id: 4100,
        executable_path: executable,
        command_line: `"${executable}" --type=utility --utility-sub-type=network.mojom.NetworkService ${override[0]} --no-proxy-server`,
      },
    ]
    expect(
      acceptance.validateOwnedProcessTree(records, {
        rootPid: 4100,
        executable,
        addressSpaceOverrideArguments: override,
        requireNetworkService: true,
      }),
    ).toEqual({ rootPid: 4100, utilityPid: 4101, networkServicePid: 4102, pids: [4100, 4101, 4102] })
    const terminatedRecords = records.map((record) => ({
      ...record,
      command_line:
        record.process_id === 4100 || record.process_id === 4102
          ? `${record.command_line} -- "--single-argument quoted positional remainder"`
          : record.command_line,
    }))
    expect(
      acceptance.validateOwnedProcessTree(terminatedRecords, {
        rootPid: 4100,
        executable,
        addressSpaceOverrideArguments: override,
        requireNetworkService: true,
      }),
    ).toEqual({ rootPid: 4100, utilityPid: 4101, networkServicePid: 4102, pids: [4100, 4101, 4102] })
    for (const hostile of [
      records.slice(0, 2),
      [...records, { ...records[2], process_id: 4103 }],
      records.map((record) =>
        record.process_id === 4100 ? { ...record, command_line: `"${executable}" --no-proxy-server` } : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? {
              ...record,
              command_line: record.command_line.replace(override[0], `${override[0]},10.20.30.41:43125=public`),
            }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100 ? { ...record, command_line: `${record.command_line} ${override[0]}` } : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: record.command_line.replace(" --no-proxy-server", "") }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100 ? { ...record, command_line: `${record.command_line} --no-proxy-server` } : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? {
              ...record,
              command_line: record.command_line.replace("--no-proxy-server", "--proxy-server=http://127.0.0.1:9999"),
            }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} --proxy-server=http://127.0.0.1:9999` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} -proxy-server=http://127.0.0.1:9999` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} /IP-ADDRESS-SPACE-OVERRIDES=0.0.0.0/0=private` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? {
              ...record,
              command_line: record.command_line.replace(
                override[0],
                "/IP-ADDRESS-SPACE-OVERRIDES=10.20.30.40:43125=public",
              ),
            }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100 ? { ...record, command_line: `${record.command_line} /No-PrOxY-SeRvEr` } : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: record.command_line.replace("--no-proxy-server", "/No-PrOxY-SeRvEr") }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} /proxy-server="http://127.0.0.1:9999"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} /proxy-server "http://127.0.0.1:9999"` }
          : record,
      ),
      ...["--single-argument", "-single-argument", "/single-argument", "--SiNgLe-ArGuMeNt"].map((single) =>
        records.map((record) =>
          record.process_id === 4100 ? { ...record, command_line: `${record.command_line} ${single}` } : record,
        ),
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} --single-argument "quoted remainder"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4100
          ? { ...record, command_line: `${record.command_line} --single-argument -- "--proxy-server=hidden"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4101
          ? { ...record, command_line: `${record.command_line} /single-argument "quoted child remainder"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: record.command_line.replace(` ${override[0]}`, "") }
          : record,
      ),
      ...["--single-argument", "-single-argument", "/single-argument", "--SiNgLe-ArGuMeNt"].map((single) =>
        records.map((record) =>
          record.process_id === 4102
            ? {
                ...record,
                command_line: `"${executable}" ${single} --type=utility --utility-sub-type=network.mojom.NetworkService ${override[0]} --no-proxy-server`,
              }
            : record,
        ),
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} --single-argument "quoted child remainder"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} /single-argument -- "--type=renderer hidden"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? {
              ...record,
              command_line: record.command_line.replace(
                `${override[0]} --no-proxy-server`,
                "--ip-address-space-overrides=0.0.0.0/0=private --proxy-server=http://127.0.0.1:9999",
              ),
            }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102 ? { ...record, command_line: `${record.command_line} ${override[0]}` } : record,
      ),
      records.map((record) =>
        record.process_id === 4102 ? { ...record, command_line: `${record.command_line} --no-proxy-server` } : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: record.command_line.replace(" --no-proxy-server", "") }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? {
              ...record,
              command_line: record.command_line.replace("--no-proxy-server", "--proxy-server=http://127.0.0.1:9999"),
            }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} --proxy-server=http://127.0.0.1:9999` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} -PrOxY-SeRvEr=http://127.0.0.1:9999` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: record.command_line.replace("--no-proxy-server", "/No-PrOxY-SeRvEr") }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} /proxy-server=http://127.0.0.1:9999` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} /ip-address-space-overrides=0.0.0.0/0=private` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} /IP-ADDRESS-SPACE-OVERRIDES=10.20.30.40:43125=public` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? {
              ...record,
              command_line: record.command_line.replace(
                override[0],
                "/IP-ADDRESS-SPACE-OVERRIDES=10.20.30.40:43125=public",
              ),
            }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} /ip-address-space-overrides="0.0.0.0/0=private"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102
          ? { ...record, command_line: `${record.command_line} /ip-address-space-overrides "0.0.0.0/0=private"` }
          : record,
      ),
      records.map((record) =>
        record.process_id === 4102 ? { ...record, executable_path: "C:\\hostile\\substituted.exe" } : record,
      ),
      records.map((record) => (record.process_id === 4102 ? { ...record, parent_process_id: 9999 } : record)),
      records.map((record) =>
        record.process_id === 4102
          ? {
              ...record,
              command_line: `"${executable}" "C:\\Acceptance Files\\--type=utility --utility-sub-type=network.mojom.NetworkService" ${override[0]} --no-proxy-server`,
            }
          : record,
      ),
    ]) {
      expect(() =>
        acceptance.validateOwnedProcessTree(hostile, {
          rootPid: 4100,
          executable,
          addressSpaceOverrideArguments: override,
          requireNetworkService: true,
        }),
      ).toThrow()
    }

    for (const [phase, hostile] of [
      ["candidate", undefined],
      ["current-beta", controlUrl],
      ["rollback", controlUrl],
      ["foreign", undefined],
      ["candidate", "http://127.0.0.1:43125/bharatcode-firewall-control"],
      ["candidate", "http://8.8.8.8:43125/bharatcode-firewall-control"],
      ["candidate", "http://10.20.30.40:0/bharatcode-firewall-control"],
      ["candidate", "http://10.20.30.40/bharatcode-firewall-control"],
      ["candidate", "http://10.20.30.40:43125/foreign"],
      ["candidate", "http://user@10.20.30.40:43125/bharatcode-firewall-control"],
      ["candidate", `${controlUrl}?drift=1`],
      ["candidate", "10.20.30.40:43125=public,10.20.30.41:43125=public"],
      ["candidate", "0.0.0.0/0=public"],
      ["candidate", "*=public"],
    ] as const) {
      expect(() => acceptance.candidateAddressSpaceOverrideArguments(phase, hostile)).toThrow()
    }

    const windows = await readFile(new URL("../src/main/windows.ts", import.meta.url), "utf8")
    const index = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8")
    expect(windows).not.toContain("ip-address-space-overrides")
    expect(index).not.toContain("ip-address-space-overrides")
  })

  test("uses four distinct one-shot controls and closes candidate netlog evidence", () => {
    const nonces = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]
    const controls = acceptance.createEgressControlUrls("http://10.20.30.40:43125", nonces)
    expect(controls).toEqual({
      harnessBefore: `http://10.20.30.40:43125/bharatcode-firewall-control/${nonces[0]}`,
      rendererBefore: `http://10.20.30.40:43125/bharatcode-firewall-control/${nonces[1]}`,
      rendererBlocked: `http://10.20.30.40:43125/bharatcode-firewall-control/${nonces[2]}`,
      harnessAfter: `http://10.20.30.40:43125/bharatcode-firewall-control/${nonces[3]}`,
    })
    expect(() => acceptance.createEgressControlUrls("http://127.0.0.1:43125", nonces)).toThrow()
    expect(() =>
      acceptance.createEgressControlUrls("http://10.20.30.40:43125", [...nonces.slice(0, 3), nonces[0]]),
    ).toThrow()
    expect(() => acceptance.createEgressControlUrls("http://10.20.30.40:43125", ["predictable"])).toThrow()

    const eventTypes = {
      URL_REQUEST_START_JOB: 1,
      HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 2,
      URL_REQUEST_FAILED: 3,
    }
    const events = [
      { source: { id: 10 }, type: 1, phase: 0, params: { method: "GET", url: controls.rendererBefore } },
      { source: { id: 10 }, type: 2, phase: 0, params: { headers: ["HTTP/1.1 204 No Content"] } },
      { source: { id: 20 }, type: 1, phase: 0, params: { method: "GET", url: controls.rendererBlocked } },
      { source: { id: 20 }, type: 3, phase: 0, params: { net_error: -118 } },
    ]
    const bytes = Buffer.from(JSON.stringify({ constants: { logEventTypes: eventTypes }, events }))
    expect(acceptance.validateCandidateEgressNetLogBytes(bytes, controls)).toBeTrue()
    for (const hostile of [
      Buffer.from(JSON.stringify({ constants: { logEventTypes: eventTypes }, events: events.slice(0, 2) })),
      Buffer.from(
        JSON.stringify({
          constants: { logEventTypes: eventTypes },
          events: [...events, { source: { id: 20 }, type: 2, phase: 0, params: { headers: ["HTTP/1.1 204"] } }],
        }),
      ),
      Buffer.from(
        JSON.stringify({
          constants: { logEventTypes: eventTypes },
          events: [...events, { source: { id: 30 }, type: 1, phase: 0, params: { url: controls.harnessAfter } }],
        }),
      ),
      Buffer.from(
        JSON.stringify({
          constants: { logEventTypes: eventTypes },
          events: events.map((event) =>
            event.type === 2 ? { ...event, params: { headers: ["HTTP/1.1 200 OK"] } } : event,
          ),
        }),
      ),
      Buffer.from(
        JSON.stringify({
          constants: { logEventTypes: eventTypes },
          events: events.map((event) =>
            event.type === 2 ? { ...event, params: { headers: ["HTTP/1.1 200 OK", "x-control: 204"] } } : event,
          ),
        }),
      ),
      Buffer.from(
        JSON.stringify({
          constants: { logEventTypes: eventTypes },
          events: events.map((event) =>
            event.source.id === 10 && event.type === 1
              ? { ...event, params: { ...event.params, method: "OPTIONS" } }
              : event,
          ),
        }),
      ),
      Buffer.from(
        JSON.stringify({
          constants: { logEventTypes: eventTypes },
          events: [
            ...events,
            { source: { id: 30 }, type: 1, phase: 0, params: { method: "OPTIONS", url: controls.rendererBefore } },
          ],
        }),
      ),
    ]) {
      expect(() => acceptance.validateCandidateEgressNetLogBytes(hostile, controls)).toThrow()
    }
  })

  test("requires enabled active firewall profiles and effective candidate-process egress blocking", () => {
    const firewall = {
      schema: "bharatcode-windows-firewall-observation-v1",
      active_profiles: ["Public"],
      control_address: "10.20.30.40",
      profiles: [
        { name: "Domain", enabled: true },
        { name: "Private", enabled: true },
        { name: "Public", enabled: true },
      ],
    }
    expect(acceptance.validateFirewallProfileObservation(firewall)).toEqual(firewall)
    for (const hostile of [
      { ...firewall, active_profiles: [] },
      { ...firewall, active_profiles: ["Public", "Public"] },
      { ...firewall, control_address: "127.0.0.1" },
      {
        ...firewall,
        profiles: firewall.profiles.map((profile) =>
          profile.name === "Public" ? { ...profile, enabled: false } : profile,
        ),
      },
    ]) {
      expect(() => acceptance.validateFirewallProfileObservation(hostile)).toThrow()
    }

    const controls = acceptance.createEgressControlUrls("http://10.20.30.40:43125", [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ])

    const egress = {
      schema: "bharatcode-candidate-egress-control-v1",
      renderer_origin: "oc://renderer",
      control_urls: controls,
      reachable_control: {
        status: 204,
        body: "",
        url: controls.rendererBefore,
        redirected: false,
        cache_control: "no-store",
        connection: "close",
        control_header: "active",
      },
      post_boundary_control: {
        status: 204,
        body: "",
        url: controls.harnessAfter,
        redirected: false,
        cache_control: "no-store",
        connection: "close",
        control_header: "active",
      },
      request_failed: true,
      preflight_observed: false,
      request_sequence_before: ["harness-before", "renderer-before"],
      request_sequence_blocked: ["harness-before", "renderer-before"],
      request_sequence_after: ["harness-before", "renderer-before", "harness-after"],
      requests_before: 2,
      requests_blocked: 2,
      requests_after: 3,
    }
    expect(acceptance.validateBlockedEgressObservation(egress, firewall)).toBeTrue()
    expect(() =>
      acceptance.validateBlockedEgressObservation(
        {
          ...egress,
          preflight_observed: true,
          request_sequence_before: ["harness-before", "renderer-preflight", "renderer-before"],
          request_sequence_blocked: ["harness-before", "renderer-preflight", "renderer-before"],
          request_sequence_after: ["harness-before", "renderer-preflight", "renderer-before", "harness-after"],
          requests_before: 3,
          requests_blocked: 3,
          requests_after: 4,
        },
        firewall,
      ),
    ).toThrow()
    for (const hostile of [
      { ...egress, renderer_origin: "https://hostile.example" },
      { ...egress, control_urls: { ...controls, rendererBefore: controls.harnessBefore } },
      {
        ...egress,
        control_urls: { ...controls, rendererBefore: controls.rendererBefore.replace("10.20.30.40", "127.0.0.1") },
      },
      { ...egress, reachable_control: { ...egress.reachable_control, status: 0 } },
      { ...egress, reachable_control: { ...egress.reachable_control, control_header: null } },
      { ...egress, reachable_control: { ...egress.reachable_control, cache_control: null } },
      { ...egress, reachable_control: { ...egress.reachable_control, connection: "keep-alive" } },
      { ...egress, post_boundary_control: { ...egress.post_boundary_control, status: 0 } },
      { ...egress, post_boundary_control: { ...egress.post_boundary_control, connection: "keep-alive" } },
      { ...egress, preflight_observed: true },
      { ...egress, request_sequence_before: ["harness-before", "renderer-before", "renderer-before"] },
      {
        ...egress,
        request_sequence_blocked: ["harness-before", "renderer-before", "renderer-blocked"],
        request_sequence_after: ["harness-before", "renderer-before", "renderer-blocked", "harness-after"],
        requests_blocked: 3,
        requests_after: 4,
      },
      { ...egress, request_sequence_after: ["harness-before", "renderer-before"], requests_after: 2 },
      { ...egress, requests_before: 1, requests_blocked: 1, requests_after: 2 },
      { ...egress, request_failed: false },
      { ...egress, requests_after: 4 },
    ]) {
      expect(() => acceptance.validateBlockedEgressObservation(hostile, firewall)).toThrow()
    }
  })

  test("always attempts every cleanup and preserves the original failure without leaking cleanup details", async () => {
    const calls: string[] = []
    const original = new Error("post-create validation failed")
    try {
      await acceptance.runAcceptanceWithCleanup(
        async () => {
          throw original
        },
        {
          processes: async () => {
            calls.push("processes")
            throw new Error("process-cleanup-sensitive-detail")
          },
          boundary: async () => {
            calls.push("boundary")
            throw new Error("firewall-removal-sensitive-detail")
          },
          audit: async () => {
            calls.push("audit")
            return true
          },
          egress: async () => {
            calls.push("egress")
            return true
          },
        },
      )
      throw new Error("cleanup failure was accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBe(original)
      expect((error as Error).message).toBe("Packaged upgrade acceptance failed; cleanup failed: processes,boundary")
      expect((error as Error).message).not.toMatch(/sensitive-detail/u)
    }
    expect(calls).toEqual(["processes", "boundary", "audit", "egress"])

    await expect(
      acceptance.runAcceptanceWithCleanup(async () => "result", {
        processes: async () => true,
        boundary: async () => false,
        audit: async () => true,
        egress: async () => true,
      }),
    ).rejects.toThrow("cleanup failed: boundary")
  })

  test("closes the public release, tag source, and selected asset API identity", async () => {
    const beta = await currentBeta()
    const asset = beta.assets[0]
    const value = {
      release: {
        id: Number(beta.release_id),
        tag_name: beta.tag,
        url: `https://api.github.com/repos/${beta.repository}/releases/${beta.release_id}`,
        assets_url: `https://api.github.com/repos/${beta.repository}/releases/${beta.release_id}/assets`,
        assets: [
          {
            id: Number(asset.asset_id),
            name: asset.filename,
            size: asset.bytes,
            digest: `sha256:${asset.sha256}`,
            url: `https://api.github.com/repos/${beta.repository}/releases/assets/${asset.asset_id}`,
          },
        ],
      },
      tag_commit_sha: beta.source_sha,
      asset: {
        id: Number(asset.asset_id),
        name: asset.filename,
        size: asset.bytes,
        digest: `sha256:${asset.sha256}`,
        url: `https://api.github.com/repos/${beta.repository}/releases/assets/${asset.asset_id}`,
      },
    }
    expect(validateCurrentBetaApiObservation(value, beta)).toEqual(value)
    for (const hostile of [
      { ...value, tag_commit_sha: "0".repeat(40) },
      { ...value, release: { ...value.release, id: 1 } },
      { ...value, release: { ...value.release, assets: [...value.release.assets, value.release.assets[0]] } },
      { ...value, asset: { ...value.asset, id: 1 } },
      { ...value, asset: { ...value.asset, size: asset.bytes - 1 } },
      { ...value, asset: { ...value.asset, digest: `sha256:${"b".repeat(64)}` } },
    ]) {
      expect(() => validateCurrentBetaApiObservation(hostile, beta)).toThrow()
    }
  })

  test("rejects a candidate installer substituted after its pinned observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lean-upgrade-installer-"))
    const path = join(root, candidate.filename)
    const bytes = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(16), Buffer.from("PE\0\0"), Buffer.alloc(16)])
    const expected = {
      ...candidate,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
    try {
      await writeFile(path, bytes)
      expect(await verifyPinnedInstaller(path, expected)).toEqual(expected)
      await writeFile(path, Buffer.concat([bytes, Buffer.from("substituted")]))
      await expect(verifyPinnedInstaller(path, expected)).rejects.toThrow(/byte|SHA|changed|identity/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects incomplete checks, ShareNext/network attempts, cleanup drift, and secret leakage", () => {
    expect(validateUpgradeExecutionObservation(observation())).toEqual(observation())
    const missing = observation() as { checks: Record<string, boolean> }
    delete missing.checks.rollback_installed
    for (const hostile of [
      missing,
      { ...observation(), checks: { ...checks(), candidate_started: false } },
      { ...observation(), checks: { ...checks(), sharenext_absent: false } },
      { ...observation(), checks: { ...checks(), share_network_attempt_absent: false } },
      { ...observation(), cleanup_complete: false },
      { ...observation(), bearer_token: "secret-value" },
    ]) {
      expect(() => validateUpgradeExecutionObservation(hostile)).toThrow()
    }
  })

  test("authenticates only the pinned GitHub release lookup and emits secret-safe failure codes", () => {
    expect(githubApiHeaders("application/vnd.github+json", "github-actions-fixture-token")).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer github-actions-fixture-token",
      "User-Agent": "bharatcode-packaged-upgrade-acceptance",
      "X-GitHub-Api-Version": "2022-11-28",
    })
    for (const token of ["", "short", "contains whitespace", "contains\nnewline"]) {
      expect(() => githubApiHeaders("application/vnd.github+json", token)).toThrow()
    }
    expect(acceptanceFailureCode(new Error("GitHub identity request failed with HTTP 403"))).toBe("GITHUB_IDENTITY")
    expect(acceptanceFailureCode(new Error("do-not-print-this-secret"))).toBe("PACKAGED_EXECUTION")
  })

  test("consumes the GitHub token before effects and excludes it from executable child environments", async () => {
    const environment = {
      GITHUB_TOKEN: "github-actions-fixture-token",
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: "C:\\Windows",
    }
    expect(consumeGithubActionsToken(environment)).toBe("github-actions-fixture-token")
    expect(Object.hasOwn(environment, "GITHUB_TOKEN")).toBe(false)

    const invalid = { GITHUB_TOKEN: "short" }
    expect(() => consumeGithubActionsToken(invalid)).toThrow()
    expect(Object.hasOwn(invalid, "GITHUB_TOKEN")).toBe(false)

    const hostile = { ...environment, GITHUB_TOKEN: "must-not-reach-child" }
    const child = Bun.spawn(
      [process.execPath, "--eval", 'process.stdout.write(String(Object.hasOwn(process.env, "GITHUB_TOKEN")))'],
      { env: acceptance.safeChildEnvironment(hostile), stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("false")
  })

  test("fails before effects for fixture substitution and pre-existing acceptance output", async () => {
    const substituted = await fixture()
    try {
      const changed = await currentBeta()
      changed.assets[0].bytes -= 1
      await writeFile(substituted.localFixture, canonicalLeanJson(changed))
      let effects = 0
      await expect(
        runLeanUpgradeAcceptance(substituted.argv, {
          ...substituted.dependencies,
          execute: async () => {
            effects += 1
            return observation()
          },
        }),
      ).rejects.toThrow(/beta|asset|identity/i)
      expect(effects).toBe(0)
    } finally {
      await rm(substituted.root, { recursive: true, force: true })
    }

    const preexisting = await fixture()
    try {
      await mkdir(preexisting.acceptanceDirectory)
      await writeFile(join(preexisting.acceptanceDirectory, "upgrade-rollback-windows-x64.json"), "hostile")
      await expect(runLeanUpgradeAcceptance(preexisting.argv, preexisting.dependencies)).rejects.toThrow(
        /create-only|already exists/i,
      )
    } finally {
      await rm(preexisting.root, { recursive: true, force: true })
    }
  })

  test("rejects non-Windows, non-x64, process timeout/failure, and rollback failure without a receipt", async () => {
    for (const hostile of [
      { platform: "linux" },
      { arch: "arm64" },
      { execute: async () => Promise.reject(new Error("candidate startup timed out")) },
      { execute: async () => Promise.reject(new Error("installer process failed")) },
      { execute: async () => Promise.reject(new Error("rollback failed")) },
    ]) {
      const input = await fixture(hostile)
      try {
        await expect(runLeanUpgradeAcceptance(input.argv, input.dependencies)).rejects.toThrow()
        expect(await Bun.file(join(input.acceptanceDirectory, "upgrade-rollback-windows-x64.json")).exists()).toBe(
          false,
        )
      } finally {
        await rm(input.root, { recursive: true, force: true })
      }
    }
  })

  test("keeps a complete synthetic adapter diagnostic and structurally unable to emit PASS", async () => {
    const input = await fixture()
    try {
      const result = await runLeanUpgradeAcceptance(input.argv, input.dependencies)
      expect(result).toEqual({ authority: "DIAGNOSTIC", receiptPath: undefined })
      expect(await Bun.file(join(input.acceptanceDirectory, "upgrade-rollback-windows-x64.json")).exists()).toBe(false)
    } finally {
      await rm(input.root, { recursive: true, force: true })
    }
  })

  test("ships explicit real installer, process, timeout, cleanup, state, recovery, and network boundaries", async () => {
    const source = await readFile(new URL("./lean-upgrade-acceptance.mjs", import.meta.url), "utf8")
    for (const required of [
      "RUNNER_ENVIRONMENT",
      "fetch(",
      'open(path, "wx"',
      "Bun.spawn(",
      '"/S"',
      '"taskkill"',
      "PROCESS_TIMEOUT_MS",
      "productNameForChannel",
      "recovery",
      "status",
      "choose-source",
      "--content-fingerprint",
      "--confirm",
      "--json",
      '"models", "opencode"',
      "BharatCode ships only the BharatCode provider",
      "candidate did not replace the beta installation",
      "rollback did not restore the exact beta installation",
      "directoryIdentity",
      "Acceptance process timed out",
      "log-net-log",
      "candidateStart.netLog",
      "rollbackStart.netLog",
      "seedLegacyBetaState",
      "initializePinnedBetaDatabase(profile.legacyDatabase)",
      "Pinned beta migration set changed",
      "observeCandidateState",
      "observeRollbackState",
      "validateStateEvidence",
      "verifyRecoveryEvidence",
      "lean-migration-v1.json",
      "migration-snapshots",
      "INSERT INTO account (",
      "ACCEPTANCE_ACCESS_SENTINEL",
      "ACCEPTANCE_REFRESH_SENTINEL",
      "legacyAccountIntact",
      "observeCredentialStoreUsability",
      "observeCredentialSentinelPresence",
      "control_account",
      "validateShareSurfaceObservation",
      "validateUnauthenticatedSidecarResponse",
      "selectRendererCdpTarget",
      "parseRendererShareEvaluation",
      "validateLoopbackListenerOwner",
      "Get-NetTCPConnection -State Listen",
      "remote-debugging-port",
      "ip-address-space-overrides",
      "candidateAddressSpaceOverrideArguments",
      "validateCandidateEgressNetLogBytes",
      "NetworkService",
      "--no-proxy-server",
      "BHARATCODE_SHARE_ACCESS_TOKEN",
      "New-NetFirewallRule",
      "0.0.0.0-126.255.255.255",
      "128.0.0.0-255.255.255.255",
      "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "Remove-NetFirewallRule",
      "validateFirewallProfileObservation",
      "validateBlockedEgressObservation",
      "runAcceptanceWithCleanup",
      "validatePackagedNetLogBytes",
      "Get-CimInstance Win32_Process",
      "initializeIsolatedProfile",
      "parseLeanUpgradeReceiptBytes",
    ]) {
      expect(source).toContain(required)
    }
    expect(source).not.toMatch(/extract|mock.*PASS|force.*PASS|app starting|recovery", "start-fresh/iu)
    expect(source).not.toContain("SELECT COUNT(*) AS count FROM account")
    expect(source).not.toContain('[runtime, "serve"')
    expect(source).not.toContain("BHARATCODE_SERVER_PASSWORD")
    expect(source).toContain("Authorization: `Bearer ${token}`")
    expect(source).toContain("githubApiHeaders")
    expect(source).toContain("GITHUB_TOKEN")
    expect(source).toContain("delete environment.GITHUB_TOKEN")
    expect(source).toContain("env: safeChildEnvironment(env)")
    expect(source).toContain('Basic realm="Secure Area"')
    expect(source).not.toContain("RemoteAddress Internet")
    const betaInstall = source.indexOf("const betaInstalled = await runInstaller(")
    const betaSchema = source.indexOf("initializePinnedBetaDatabase(profile.legacyDatabase)")
    const candidateInstall = source.indexOf("runInstaller(input.candidate")
    const recovery = source.indexOf("completeCandidateRecovery(candidateRuntime, profile)")
    const egressStart = source.indexOf("egress = startLocalEgressControl(firewall.control_address)")
    const candidateStart = source.indexOf("const candidateStart = await startDesktop(")
    const liveShareProbe = source.indexOf("observeShareSurface(profile, candidateStart")
    const candidateCleanup = source.indexOf(
      'finishDesktop(candidateStart, active, profile, "candidate", share.controls)',
    )
    const shareObserver = source.indexOf("async function observeShareSurface(")
    const rendererControl = source.indexOf("evaluateRendererEgressControl(", shareObserver)
    const networkBoundary = source.indexOf("installCandidateNetworkBoundary(desktop.executable", shareObserver)
    const blockedRendererControl = source.indexOf("evaluateRendererShareRequests(", shareObserver)
    const networkBoundaryCleanup = source.indexOf(
      "removeCandidateNetworkBoundary(candidateInstalled.application.executable",
    )
    expect(betaInstall).toBeGreaterThan(-1)
    expect(betaSchema).toBeGreaterThan(betaInstall)
    expect(source).not.toContain('profile, "current-beta", active')
    expect(source).toContain("current_beta_installed: true")
    expect(candidateInstall).toBeGreaterThan(betaSchema)
    expect(recovery).toBeGreaterThan(candidateInstall)
    expect(egressStart).toBeGreaterThan(recovery)
    expect(candidateStart).toBeGreaterThan(egressStart)
    expect(liveShareProbe).toBeGreaterThan(candidateStart)
    expect(candidateCleanup).toBeGreaterThan(liveShareProbe)
    expect(rendererControl).toBeGreaterThan(shareObserver)
    expect(networkBoundary).toBeGreaterThan(rendererControl)
    expect(blockedRendererControl).toBeGreaterThan(networkBoundary)
    expect(networkBoundaryCleanup).toBeGreaterThan(candidateCleanup)
    expect(basename(fixturePath)).toBe("current-beta-windows-x64.json")
  })

  test("closes the root application gracefully before forcing its process tree", () => {
    expect(acceptance.terminationCommand(4123, false)).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$process = Get-Process -Id 4123 -ErrorAction Stop; if (-not $process.CloseMainWindow()) { exit 3 }",
    ])
    expect(acceptance.terminationCommand(4123, true)).toEqual(["taskkill", "/PID", "4123", "/T", "/F"])
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(() => acceptance.terminationCommand(invalid, false)).toThrow()
    }
  })
})
